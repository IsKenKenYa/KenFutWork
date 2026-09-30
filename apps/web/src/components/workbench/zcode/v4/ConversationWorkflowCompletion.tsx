/**
 * zcode 照搬：`@/v4/ConversationWorkflowCompletion.tsx`（references/zcode/packages/ui/src/v4/ConversationWorkflowCompletion.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */

import { WorkflowArtifactTilePreview } from "@zui/app-shell/workflow-artifacts/WorkflowArtifactTilePreview";
import type { WorkflowCompletionArtifact } from "@zui/components/workflow-timeline/WorkflowArtifactTile";
import {
  completionArtifactLayout,
  completionPreviewIds,
} from "@zui/components/workflow-timeline/WorkflowCompletionArtifacts";
import {
  WorkflowCompletionCard,
  type WorkflowCompletionFigures,
} from "@zui/components/workflow-timeline/WorkflowCompletionCard";
import {
  useWorkflowRunArtifacts,
  type WorkflowRunArtifactView,
} from "@zui/hooks/useWorkflowRunArtifacts";
import type { WorkflowRunArtifactSummary } from "@zui/lib/zcode-shared/zcode-protocol-v4";
import type { ConversationRowRenderContext } from "@zui/v4/conversationRowContext";
import { useHasV4Conversation } from "@zui/v4/V4ConversationContext";
import type { WorkflowTurnCompletion } from "@zui/v4/workflowTurnCompletion";
import { useMemo } from "react";

/**
 * 完成卡的落位：把解析出的完成事实接上
 * 宿主回调与产物取数。回调的存在即门控（照 `ConversationWorkflowDigests`）：⤢ 要
 * `onOpenWorkflowRun` + sessionId + 联接到的 `toolCallId`；瓦片与药丸要 `onOpenWorkflowArtifact`
 * + sessionId（不需要 toolCallId，与通知行同一条门）。
 *
 * 产物清单**以通知载荷为底**（随通知持久化，冷恢复也在），会话在场时再经既有的产物 hook 补
 * 字节数 / 出处 / 看板 spec / 交付物旗子，并给交付物的框挂预览。没有会话上下文的宿主（静态渲染、
 * 回放）画的是只有字形的冷态卡——同一张卡，少一层。
 */
export function ConversationWorkflowCompletion({
  completion,
  context,
  turnKey,
}: {
  completion: WorkflowTurnCompletion;
  context: ConversationRowRenderContext;
  turnKey: string;
}) {
  const hasConversation = useHasV4Conversation();
  const sessionId = context.sessionId ?? undefined;
  const { summary } = completion;
  const run = summary?.run;

  const figures: WorkflowCompletionFigures = {
    ...(completion.durationMs === undefined
      ? {}
      : { durationMs: completion.durationMs }),
    ...(run === undefined
      ? {}
      : {
          tokens: run.usage.spentTokens,
          subagents: run.actors.length,
          // 卡上不说「步」：第四格是进过的阶段数；无标记脚本没有它，格写 `—`。
          ...(run.phases !== undefined && run.phases.length > 0
            ? { phases: run.phases.length }
            : {}),
        }),
  };
  const onOpenRun =
    context.onOpenWorkflowRun && sessionId && summary?.toolCallId
      ? () =>
          context.onOpenWorkflowRun?.({
            parentSessionId: sessionId,
            toolCallId: summary.toolCallId!,
            runId: completion.runId,
            workflowName: completion.name,
          })
      : undefined;
  // 打开请求按**当时手上那份清单**构造，所以是一个按清单取参的工厂而不是一个闭死的回调：
  // 冷态只有通知载荷（有 `contentType`，没有 `sourcePath`），活路径下
  // `WorkflowCompletionWithData` 拿补齐过的那份再造一次，出处才带得上。宿主据 `contentType`
  // 决定 html 产物直接开浏览器 tab。
  const openArtifactFrom =
    context.onOpenWorkflowArtifact && sessionId
      ? (artifacts: readonly WorkflowCompletionArtifact[]) =>
          (artifactId: string) => {
            const artifact = artifacts.find(
              (candidate) => candidate.id === artifactId,
            );
            context.onOpenWorkflowArtifact?.({
              parentSessionId: sessionId,
              runId: completion.runId,
              artifactId,
              ...(artifact?.title === undefined
                ? {}
                : { title: artifact.title }),
              ...(artifact?.contentType === undefined
                ? {}
                : { contentType: artifact.contentType }),
              ...(artifact?.sourcePath === undefined
                ? {}
                : { sourcePath: artifact.sourcePath }),
            });
          }
      : undefined;
  const onOpenArtifact = openArtifactFrom?.(completion.artifacts);

  const shared = {
    artifactsTruncated: completion.artifactsTruncated,
    figures,
    name: completion.name,
    testIdKey: turnKey,
    ...(onOpenRun === undefined ? {} : { onOpenRun }),
    ...(onOpenArtifact === undefined ? {} : { onOpenArtifact }),
  };

  if (!hasConversation || sessionId === undefined) {
    return (
      <WorkflowCompletionCard {...shared} artifacts={completion.artifacts} />
    );
  }
  return (
    <WorkflowCompletionWithData
      completion={completion}
      live={run?.artifacts}
      sessionId={sessionId}
      shared={shared}
      theme={context.theme}
      {...(openArtifactFrom === undefined ? {} : { openArtifactFrom })}
    />
  );
}

/**
 * 通知载荷的清单 + hook 视图的补充。顺序与身份归载荷（它是通知那一刻的事实，且交付物已在最前）；
 * 载荷被砍过（超 8）时 journal 里多出来的产物追加在末尾，进索引或「还有 N 个」。旗子与说明两个来源
 * 任一带上即算（老载荷没有这两个键，hook 从 journal 补回来）。
 */
function mergeCompletionArtifacts(
  base: readonly WorkflowCompletionArtifact[],
  views: readonly WorkflowRunArtifactView[],
): WorkflowCompletionArtifact[] {
  const byId = new Map(views.map((view) => [view.id, view] as const));
  const merged = base.map((artifact) => {
    const view = byId.get(artifact.id);
    if (view === undefined) return artifact;
    byId.delete(artifact.id);
    return {
      ...artifact,
      version: Math.max(artifact.version ?? 1, view.version),
      ...(view.contentType === undefined
        ? {}
        : { contentType: view.contentType }),
      ...(view.bytes === undefined ? {} : { bytes: view.bytes }),
      ...(view.sourcePath === undefined ? {} : { sourcePath: view.sourcePath }),
      ...(view.spec === undefined ? {} : { spec: view.spec }),
      ...(view.description === undefined
        ? {}
        : { description: view.description }),
      ...(view.primary === true ? { primary: true as const } : {}),
      itemCount: view.itemCount,
    } satisfies WorkflowCompletionArtifact;
  });
  for (const view of byId.values()) {
    merged.push({
      id: view.id,
      kind: view.kind,
      version: view.version,
      itemCount: view.itemCount,
      ...(view.title === undefined ? {} : { title: view.title }),
      ...(view.contentType === undefined
        ? {}
        : { contentType: view.contentType }),
      ...(view.bytes === undefined ? {} : { bytes: view.bytes }),
      ...(view.sourcePath === undefined ? {} : { sourcePath: view.sourcePath }),
      ...(view.spec === undefined ? {} : { spec: view.spec }),
      ...(view.description === undefined
        ? {}
        : { description: view.description }),
      ...(view.primary === true ? { primary: true as const } : {}),
    });
  }
  return merged;
}

function WorkflowCompletionWithData({
  completion,
  live,
  openArtifactFrom,
  sessionId,
  shared,
  theme,
}: {
  completion: WorkflowTurnCompletion;
  live: readonly WorkflowRunArtifactSummary[] | undefined;
  /** 打开请求的工厂；缺席即宿主没给打开能力（门与 `shared.onOpenArtifact` 同一条）。 */
  openArtifactFrom?: (
    artifacts: readonly WorkflowCompletionArtifact[],
  ) => (artifactId: string) => void;
  sessionId: string;
  shared: Omit<
    Parameters<typeof WorkflowCompletionCard>[0],
    "artifacts" | "renderPreview"
  >;
  theme: ConversationRowRenderContext["theme"];
}) {
  const state = useWorkflowRunArtifacts({
    sessionId,
    runId: completion.runId,
    ...(live === undefined ? {} : { live }),
  });
  const artifacts = useMemo(
    () => mergeCompletionArtifacts(completion.artifacts, state.artifacts),
    [completion.artifacts, state.artifacts],
  );
  // `artifactsTruncated` 说的是**通知载荷**被砍在 8 件，而这里画的清单已经由活投影 /
  // journal 补齐（产物多的 run 是常态），`+N` 与「还有 N 个」却仍按载荷的旗子写成省略号——用户看到的
  // 是「还有 … 个」，而数字明明已经知道。清单完整时旗子作废；只有老 CLI（查不到 journal）或还没
  // 答上来时才仍是省略号，那时数字确实不可知。
  const artifactsTruncated =
    shared.artifactsTruncated === true && !state.complete;
  const renderPreview = (artifact: WorkflowCompletionArtifact) => (
    <WorkflowArtifactTilePreview
      artifact={artifact}
      key={`${artifact.id}:${artifact.version ?? 1}`}
      runId={completion.runId}
      sessionId={sessionId}
      theme={theme}
    />
  );
  // 只有画出来的框挂预览——今天只有交付物行有框；索引行与「还有 N 个」不读字节。
  const previewIds = useMemo(
    () =>
      completionPreviewIds(
        completionArtifactLayout(artifacts, artifactsTruncated),
      ),
    [artifacts, artifactsTruncated],
  );
  // 补齐过的清单重造一次回调：载荷上没有的 `sourcePath`、老载荷上没有的 `contentType`
  // 都从 journal / 活投影补回来，点开的那一下才带得全。
  const onOpenArtifact = openArtifactFrom?.(artifacts);
  return (
    <WorkflowCompletionCard
      {...shared}
      {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
      artifactsTruncated={artifactsTruncated}
      artifacts={artifacts}
      renderPreview={(artifact) =>
        previewIds.has(artifact.id) ? renderPreview(artifact) : undefined
      }
    />
  );
}
