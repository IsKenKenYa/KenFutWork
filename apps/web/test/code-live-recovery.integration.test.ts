import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgentConversationTransport } from "@zui/v4/agentConversationTransport";
import { SessionDataLayer } from "@zui/v4/sessionDataLayer";
import { expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";

// 手动只读诊断：连接显式指定的现存本机Task，不发模型输入、停止或配置变更。
it.skipIf(process.env.KFW_TEST_LIVE_RECOVERY !== "1")(
  "原HTTP客户端与SessionDataLayer恢复真实大截图Task",
  async () => {
    const data = process.env.KFW_TEST_DATA_ROOT;
    const taskId = process.env.KFW_TEST_TASK_ID;
    const projectId = process.env.KFW_TEST_PROJECT_ID;
    if (!data || !taskId || !projectId)
      throw new Error("真实恢复诊断需显式指定数据根、Project与Task");
    const token = (
      await readFile(join(data, "local-access", "desktop-token"), "utf8")
    ).trim();
    const nativeFetch = globalThis.fetch;
    let disconnect: AbortController | undefined;
    let connections = 0;
    const methods: string[] = [];
    vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
      if (String(url).endsWith("/events")) {
        disconnect = new AbortController();
        connections++;
        return nativeFetch(url, {
          ...options,
          signal: AbortSignal.any([
            disconnect.signal,
            ...(options?.signal ? [options.signal] : []),
          ]),
        });
      }
      if (options?.body) methods.push(JSON.parse(String(options.body)).method);
      return nativeFetch(url, options);
    });
    const client = new CodeHttpChannelClient({
      apiBase: "http://127.0.0.1:3301",
      accessToken: token,
    });
    let layer: SessionDataLayer | undefined;
    let release: (() => void) | undefined;
    let stopObserving: (() => void) | undefined;
    try {
      await client.connect();
      const projects = await client.refreshWorkspaces();
      const project = projects.find((item) => item.projectId === projectId);
      if (!project) throw new Error("指定的Code项目已不可用");
      const transport = createAgentConversationTransport(
        client.services.zcodeAgentService,
        {
          workspacePath: project.path,
          workspaceIdentity: JSON.stringify([project.projectId, project.path]),
        },
      );
      const frames: Array<{
        subscriptionId: string;
        kind: string | undefined;
      }> = [];
      stopObserving = transport.onFrame((frame, context) => {
        frames.push({
          subscriptionId: frame.subscriptionId,
          kind: context?.deliveryKind,
        });
      });
      layer = new SessionDataLayer({ transport, keepWarmMs: 0 });
      const lease = layer.acquire(taskId);
      release = lease.release;
      await expect
        .poll(() => lease.store.getState().status, { timeout: 12_000 })
        .toBe("live");
      await expect
        .poll(() => lease.store.getState().snapshot?.sessionId, {
          timeout: 12_000,
        })
        .toBe(taskId);
      const initial = lease.store.getState();
      expect(initial.snapshot?.sessionId).toBe(taskId);
      console.log("[live-recovery] initial", {
        status: initial.status,
        seq: initial.snapshot?.seq,
        rows: initial.snapshot?.rows.totalCount,
      });
      for (let index = 0; index < 3; index++) {
        lease.store.recoverFromStaleAuthority();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(frames.some((frame) => frame.kind === "recovery")).toBe(true);
      expect(lease.store.getState().lastError).toBeNull();
      expect(lease.store.getState().snapshot?.seq).toBeGreaterThanOrEqual(
        initial.snapshot?.seq ?? 0,
      );
      const oldSubscription = lease.store.getState().subscriptionId;
      disconnect?.abort();
      await expect.poll(() => connections, { timeout: 12_000 }).toBe(2);
      await expect
        .poll(() => lease.store.getState().subscriptionId, { timeout: 12_000 })
        .not.toBe(oldSubscription);
      await expect
        .poll(() => lease.store.getState().snapshot?.sessionId, {
          timeout: 12_000,
        })
        .toBe(taskId);
      await expect
        .poll(
          () =>
            frames.some(
              (frame) =>
                frame.kind === "initial" &&
                frame.subscriptionId === lease.store.getState().subscriptionId,
            ),
          { timeout: 12_000 },
        )
        .toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 31_000));
      console.log("[live-recovery] final", {
        status: lease.store.getState().status,
        error: lease.store.getState().lastError,
      });
      expect(lease.store.getState().status).toBe("live");
      expect(lease.store.getState().lastError).toBeNull();
      console.log("[live-recovery] RPC methods", methods);
    } finally {
      release?.();
      layer?.dispose();
      stopObserving?.();
      client.dispose();
      vi.unstubAllGlobals();
    }
  },
  50_000,
);
