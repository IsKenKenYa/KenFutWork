import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { ModelProviderService } from "../features/model-providers/model-provider-service.js";
import type { ModelInvocationSnapshot } from "../providers/types.js";
import {
  createRunModelControl,
  resolveInstanceModelExecution,
} from "./model-execution.js";
import { nativeEffectiveOutputTokens } from "./native-context-budget.js";

const providerId = randomUUID();
const actor = { instanceId: randomUUID(), accessClientId: null };
const snapshot = (output: number): ModelInvocationSnapshot => ({
  providerId,
  modelId: "gateway-model",
  configRevision: 1,
  useResponsesApi: false,
  body: { max_tokens: output },
  inputCapabilities: { image: true, pdf: false },
});
const providers: Pick<ModelProviderService, "resolveCredentials"> = {
  resolveCredentials: async (user, selected) => {
    if (user.instanceId !== actor.instanceId || selected !== providerId)
      throw new Error("wrong private provider binding");
    return {
      instanceId: providerId,
      name: "fixture",
      protocol: "openai-compatible",
      apiKey: "fixture",
      configRevision: 1,
      responsesApi: true,
      models: [
        {
          id: "gateway-model",
          name: "gateway",
          capability: "chat",
          extraBody: { max_tokens: 16_000, legacy: "deleted option" },
        },
      ],
    };
  },
};
const resolve = (invocation: ModelInvocationSnapshot) =>
  resolveInstanceModelExecution({
    actor,
    specifier: `${providerId}:gateway-model`,
    invocation,
    providers,
    headers: {},
  });

it("default Provider contract preserves frozen body/capabilities/owner and exports actual output cap", async () => {
  const result = await resolve(snapshot(321));
  expect(result.effectiveOutputTokens).toBe(321);
  expect(result.capabilities).toEqual({ image: true, pdf: false });
  expect(result.owner).toEqual({
    provider: "instance",
    model: "gateway-model",
    providerInstanceId: providerId,
    configRevision: 1,
  });
  const model = result.model;
  if (
    !("invocationParams" in model) ||
    typeof model.invocationParams !== "function"
  )
    throw new Error("native parameter port missing");
  expect(model.invocationParams.call(model)).toMatchObject({ max_tokens: 321 });
  expect(model.invocationParams.call(model)).not.toHaveProperty("legacy");
  await expect(
    resolve({ ...snapshot(321), configRevision: 2 }),
  ).rejects.toThrow("配置已改变");
});

it("one ModelControl activates frozen desired wire budget only after both trusted validations", async () => {
  const initial = await resolve(snapshot(321));
  const calls: string[] = [];
  const budget = { effectiveOutputTokens: initial.effectiveOutputTokens };
  const control = createRunModelControl({
    initialModel: initial.model,
    initialInvocation: snapshot(321),
    validate: async () => {
      calls.push("validate");
    },
    resolve: async (invocation) => {
      calls.push("resolve");
      return resolve(invocation);
    },
    apply: async (execution) => {
      calls.push("apply");
      budget.effectiveOutputTokens = execution.effectiveOutputTokens;
    },
  });
  const desired = snapshot(1_024);
  control.selectInvocation(desired);
  desired.body.max_tokens = 2_048;
  const selected = await control.resolveCurrent();
  expect(calls).toEqual(["validate", "resolve", "validate", "apply"]);
  expect(nativeEffectiveOutputTokens(selected)).toBe(1_024);
  expect(budget.effectiveOutputTokens).toBe(1_024);
  expect(await control.resolveCurrent()).toBe(selected);
  expect(calls).toHaveLength(4);
});
