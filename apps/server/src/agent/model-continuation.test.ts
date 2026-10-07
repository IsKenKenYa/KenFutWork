import { createRequire } from "node:module";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import {
  type AgentMiddleware,
  createAgent,
  tool,
  toolStrategy,
} from "langchain";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const cjs: typeof import("langchain") = createRequire(import.meta.url)(
  "langchain",
);
const sdkEntries = [
  { name: "ESM", createAgent, tool, toolStrategy },
  {
    name: "CJS",
    createAgent: cjs.createAgent,
    tool: cjs.tool,
    toolStrategy: cjs.toolStrategy,
  },
];
const versions: Array<"v1" | "v2"> = ["v1", "v2"];
const guideId = "continuation-guide";
const guideText = "保留中间答复，再依据这条指导继续。";

type ScriptAnswer = AIMessage | ((toolNames: readonly string[]) => AIMessage);

/** 仅替换外部模型边界；有限脚本使多余请求直接失败，不替换SDK路由或节点。 */
class FiniteModel extends BaseChatModel {
  readonly requests: BaseMessage[][] = [];
  private toolNames: string[] = [];

  constructor(private readonly answers: readonly ScriptAnswer[]) {
    super({ disableStreaming: true });
  }

  _llmType() {
    return "public-model-continuation-regression";
  }

  bindTools(tools: Parameters<NonNullable<BaseChatModel["bindTools"]>>[0]) {
    this.toolNames = tools.map(
      (definition) => convertToOpenAITool(definition).function.name,
    );
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const answer = this.answers[this.requests.length];
    this.requests.push([...messages]);
    if (!answer) throw new Error("有限模型脚本收到多余请求，运行不应继续。");
    const message =
      typeof answer === "function" ? answer(this.toolNames) : answer;
    return {
      generations: [
        {
          message,
          text: typeof message.content === "string" ? message.content : "",
        },
      ],
    };
  }
}

function requestAt(model: FiniteModel, index: number): BaseMessage[] {
  const request = model.requests[index];
  if (!request) throw new Error(`未发生第${index + 1}次实际模型调用。`);
  return request;
}

function transcript(messages: readonly { id?: string; content: unknown }[]) {
  return messages.map((message) => ({
    id: message.id,
    content: message.content,
  }));
}

function guideBoundary(
  model: FiniteModel,
  index: number,
  visits: number[],
): AgentMiddleware {
  return {
    name: `GuideBoundary${index}`,
    beforeModel(state) {
      visits.push(index);
      if ("jumpTo" in state) expect(state.jumpTo).toBeUndefined();
      const messages: BaseMessage[] = state.messages;
      if (
        index === 0 &&
        model.requests.length === 1 &&
        !messages.some((message) => message.id === guideId)
      )
        return {
          messages: [new HumanMessage({ id: guideId, content: guideText })],
        };
      return {};
    },
  };
}

/** 公共createAgent版本参数描述v1/v2工具行为；两个发行入口都走同一组公开用例。 */
for (const sdk of sdkEntries) {
  for (const version of versions) {
    describe(`${sdk.name}/${version} SDK公共模型续跑`, () => {
      for (const beforeCount of [0, 1, 3]) {
        for (const position of ["final", "sequence"]) {
          const title = `${beforeCount} beforeModel/${position}跳转保留历史并结束`;
          it(title, async () => {
            const model = new FiniteModel([
              new AIMessage({ id: "ai-first", content: "真实中间答复" }),
              new AIMessage({ id: "ai-final", content: "真实最终答复" }),
            ]);
            const visits: number[] = [];
            let afterCalls = 0;
            const jumper: AgentMiddleware = {
              name: "ContinueOnce",
              afterModel: {
                canJumpTo: ["model"],
                hook() {
                  afterCalls += 1;
                  return afterCalls === 1 ? { jumpTo: "model" } : {};
                },
              },
            };
            const observer: AgentMiddleware = {
              name: "AfterModelObserver",
              afterModel: () => ({}),
            };
            const boundaries = Array.from({ length: beforeCount }, (_, index) =>
              guideBoundary(model, index, visits),
            );
            const agent = sdk.createAgent({
              model,
              version,
              middleware: [
                ...boundaries,
                ...(position === "sequence" ? [observer, jumper] : [jumper]),
              ],
            });
            const initial = { id: "initial", content: "原始用户请求" };
            const result = await agent.invoke({
              messages: [new HumanMessage({ ...initial })],
            });
            const guide = beforeCount
              ? [{ id: guideId, content: guideText }]
              : [];
            const beforeOrder = Array.from(
              { length: beforeCount },
              (_, index) => index,
            );
            expect(visits).toEqual([...beforeOrder, ...beforeOrder]);
            expect(afterCalls).toBe(2);
            expect(model.requests).toHaveLength(2);
            expect(transcript(requestAt(model, 0))).toEqual([initial]);
            expect(transcript(requestAt(model, 1))).toEqual([
              initial,
              { id: "ai-first", content: "真实中间答复" },
              ...guide,
            ]);
            expect(transcript(result.messages)).toEqual([
              initial,
              { id: "ai-first", content: "真实中间答复" },
              ...guide,
              { id: "ai-final", content: "真实最终答复" },
            ]);
          });
        }
      }

      for (const routing of ["default", "explicitTools"]) {
        it(`${routing}工具只执行一次，结果后经过beforeModel`, async () => {
          const model = new FiniteModel([
            new AIMessage({
              id: "tool-ai",
              content: "",
              tool_calls: [
                { id: "lookup-call", name: "lookup", args: { value: "证据" } },
              ],
            }),
            new AIMessage({ id: "tool-final", content: "工具与指导均已收到" }),
          ]);
          const executed: string[] = [];
          const lookup = sdk.tool(
            async ({ value }) => {
              executed.push(value);
              return `真实工具结果：${value}`;
            },
            {
              name: "lookup",
              description: "返回实际调用的测试证据",
              schema: z.object({ value: z.string() }),
            },
          );
          const visits: number[] = [];
          const afterModel: AgentMiddleware = {
            name: "ToolRoutingAfterModel",
            afterModel: {
              canJumpTo: ["tools"],
              hook(state) {
                const messages: BaseMessage[] = state.messages;
                const last = messages.at(-1);
                if (
                  routing === "explicitTools" &&
                  AIMessage.isInstance(last) &&
                  last.tool_calls?.length
                )
                  return { jumpTo: "tools" };
                return {};
              },
            },
          };
          const agent = sdk.createAgent({
            model,
            version,
            tools: [lookup],
            middleware: [guideBoundary(model, 0, visits), afterModel],
          });
          const result = await agent.invoke({
            messages: [
              new HumanMessage({ id: "tool-input", content: "调用证据工具" }),
            ],
          });
          expect(executed).toEqual(["证据"]);
          expect(visits).toEqual([0, 0]);
          expect(model.requests).toHaveLength(2);
          const toolResults = requestAt(model, 1).filter(
            ToolMessage.isInstance,
          );
          expect(toolResults).toHaveLength(1);
          expect(toolResults[0]).toMatchObject({
            tool_call_id: "lookup-call",
            content: "真实工具结果：证据",
          });
          expect(result.messages.map((message) => message.content)).toEqual([
            "调用证据工具",
            "",
            "真实工具结果：证据",
            guideText,
            "工具与指导均已收到",
          ]);
          expect(result.messages.filter(ToolMessage.isInstance)).toHaveLength(
            1,
          );
          expect(
            result.messages.filter((message) => message.id === guideId),
          ).toHaveLength(1);
        });
      }

      it("显式end不执行工具或额外模型请求", async () => {
        const model = new FiniteModel([
          new AIMessage({
            id: "stopped-ai",
            content: "停止在这个模型边界",
            tool_calls: [{ id: "blocked-call", name: "blocked", args: {} }],
          }),
        ]);
        let executions = 0;
        const blocked = sdk.tool(
          async () => {
            executions += 1;
            return "不应执行";
          },
          {
            name: "blocked",
            description: "显式end应阻止该调用",
            schema: z.object({}),
          },
        );
        const ending: AgentMiddleware = {
          name: "ExplicitEnd",
          afterModel: { canJumpTo: ["end"], hook: () => ({ jumpTo: "end" }) },
        };
        const agent = sdk.createAgent({
          model,
          version,
          tools: [blocked],
          middleware: [ending],
        });
        const result = await agent.invoke({
          messages: [new HumanMessage("结束本轮")],
        });
        expect(executions).toBe(0);
        expect(model.requests).toHaveLength(1);
        expect(
          result.messages
            .filter(AIMessage.isInstance)
            .map((message) => message.id),
        ).toEqual(["stopped-ai"]);
      });

      it("afterAgent跳转不重新调用beforeModel", async () => {
        const model = new FiniteModel([
          new AIMessage({ id: "after-agent-first", content: "第一次完成" }),
          new AIMessage({ id: "after-agent-final", content: "收尾续跑完成" }),
        ]);
        let beforeCalls = 0;
        let afterCalls = 0;
        const before: AgentMiddleware = {
          name: "BeforeAgentCompatibility",
          beforeModel() {
            beforeCalls += 1;
            return {};
          },
        };
        const after: AgentMiddleware = {
          name: "AfterAgentCompatibility",
          afterAgent: {
            canJumpTo: ["model"],
            hook() {
              afterCalls += 1;
              return afterCalls === 1 ? { jumpTo: "model" } : {};
            },
          },
        };
        const agent = sdk.createAgent({
          model,
          version,
          middleware: [before, after],
        });
        const result = await agent.invoke({
          messages: [new HumanMessage("检查收尾兼容")],
        });
        expect(beforeCalls).toBe(1);
        expect(afterCalls).toBe(2);
        expect(model.requests).toHaveLength(2);
        expect(
          result.messages
            .filter(AIMessage.isInstance)
            .map((message) => message.id),
        ).toEqual(["after-agent-first", "after-agent-final"]);
      });

      it("公开toolStrategy结构化回复保持默认终态", async () => {
        const model = new FiniteModel([
          (toolNames) => {
            const name = toolNames.find((candidate) =>
              candidate.startsWith("extract-"),
            );
            if (!name) throw new Error("SDK未向外部模型绑定实际结构化工具。");
            return new AIMessage({
              id: "structured-ai",
              content: "",
              tool_calls: [
                { id: "structured-call", name, args: { answer: "结构化证据" } },
              ],
            });
          },
        ]);
        const agent = sdk.createAgent({
          model,
          version,
          responseFormat: sdk.toolStrategy(z.object({ answer: z.string() }), {
            handleError: false,
          }),
          middleware: [
            { name: "DefaultStructuredAfterModel", afterModel: () => ({}) },
          ],
        });
        const result = await agent.invoke({
          messages: [new HumanMessage("返回结构化证据")],
        });
        expect(result.structuredResponse).toEqual({ answer: "结构化证据" });
        expect(model.requests).toHaveLength(1);
        const encoded = JSON.stringify({ answer: "结构化证据" });
        const summary = `Returning structured response: ${encoded}`;
        // toolStrategy正常输出还包含工具确认与SDK总结；它们不代表第二次模型调用。
        expect(result.messages.map((message) => message.content)).toEqual([
          "返回结构化证据",
          "",
          encoded,
          summary,
        ]);
        const aiMessages = result.messages.filter(AIMessage.isInstance);
        expect(aiMessages.map((message) => message.content)).toEqual([
          "",
          summary,
        ]);
        expect(aiMessages[0]).toMatchObject({
          id: "structured-ai",
          tool_calls: [
            { id: "structured-call", args: { answer: "结构化证据" } },
          ],
        });
        expect(result.messages.filter(ToolMessage.isInstance)).toMatchObject([
          { tool_call_id: "structured-call", content: encoded },
        ]);
        expect(result.messages.filter(HumanMessage.isInstance)).toHaveLength(1);
      });
    });
  }
}
