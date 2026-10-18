import {
  access,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createMacosCadGuiDocumentReader } from "./gui-document-reader.js";
import type { CadGuiApplication } from "./gui-probe.js";
import { CadGuiProbeError } from "./gui-probe.js";
import { CadGuiTransportError } from "./gui-transport.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(replyChange: Record<string, unknown> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kfw-gui-reader-")));
  roots.push(root);
  const application: CadGuiApplication = {
    pid: 1234,
    launchedAt: 1000,
    birth: { startSeconds: 1, startMicroseconds: 123_456 },
    bundleId: "org.freecad.FreeCAD",
    name: "FreeCAD",
    executablePath: "/Applications/FreeCAD.app/Contents/Resources/bin/freecad",
    bundlePath: "/Applications/FreeCAD.app",
  };
  const probe = {
    list: vi.fn(async () => [application]),
    verify: vi.fn(async () => application),
  };
  const controller = new AbortController();
  const context = {
    signal: controller.signal,
    timeoutMs: 2000,
    maxOutputBytes: 8000,
  };
  let directory = "";
  const send = vi.fn(
    async (_application: CadGuiApplication, macroPath: string) => {
      directory = dirname(macroPath);
      const request = JSON.parse(
        await readFile(join(directory, "request.json"), "utf8"),
      );
      await writeFile(
        join(directory, "reply.json"),
        JSON.stringify({
          protocol: "kfw-cad-gui-query/2",
          requestId: request.requestId,
          pid: application.pid,
          completed: true,
          guiThread: true,
          success: true,
          version: ["1", "1", "4"],
          bridgeEpoch: "b1ff2ef8-0854-40c9-9da8-c9ff07bfb219",
          applicationRevision: 2,
          documents: [
            {
              name: "Part",
              documentHandle: "28686cba-59d6-44c3-a30c-bbca88a7d737",
              revision: 3,
              label: "用户零件",
              fileName: "/outside-task/part.FCStd",
              uid: "native-uid",
              modified: true,
              touched: false,
              pendingTransaction: true,
              active: true,
            },
          ],
          ...replyChange,
        }),
        { mode: 0o600 },
      );
    },
  );
  const reader = createMacosCadGuiDocumentReader({
    probe,
    transport: { send },
    rootDirectory: root,
  });
  return {
    root,
    application,
    probe,
    controller,
    context,
    send,
    reader,
    directory: () => directory,
  };
}

test("固定查询验证前后应用身份，返回原生元数据且完成后清理私有回执", async () => {
  const f = await fixture();
  const result = await f.reader.read(f.application, f.context);
  expect(result.documents).toEqual([
    {
      name: "Part",
      documentHandle: "28686cba-59d6-44c3-a30c-bbca88a7d737",
      revision: 3,
      label: "用户零件",
      fileName: "/outside-task/part.FCStd",
      uid: "native-uid",
      modified: true,
      touched: false,
      pendingTransaction: true,
      active: true,
    },
  ]);
  expect(result).toMatchObject({
    bridgeEpoch: "b1ff2ef8-0854-40c9-9da8-c9ff07bfb219",
    applicationRevision: 2,
  });
  expect(result.observationId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(f.probe.verify).toHaveBeenCalledTimes(2);
  expect(f.send).toHaveBeenCalledOnce();
  expect(await readdir(f.root)).toEqual([]);
});

test.each([
  { requestId: "4304af88-45ae-43a8-9ef3-ad4f6a0d1771" },
  { pid: 1235 },
  { guiThread: false },
  { geometry: { volume: 100 } },
  { protocol: "kfw-cad-gui-query/1" },
  { bridgeEpoch: "untrusted-bridge" },
  { applicationRevision: -1 },
  { bridgeEpoch: null },
  { applicationRevision: null },
])("拒绝不属于本次固定查询的回执 %j，不返回文档", async (changed) => {
  const f = await fixture(changed);
  await expect(f.reader.read(f.application, f.context)).rejects.toMatchObject({
    code: "query_failed",
    observationConfirmed: false,
    actionSent: true,
  });
  expect(f.send).toHaveBeenCalledOnce();
  expect((await stat(join(f.directory(), "query.FCMacro"))).mode & 0o777).toBe(
    0o600,
  );
  await expect(
    access(join(f.directory(), "cancelled")),
  ).resolves.toBeUndefined();
});

test("合法失败ACK不签发虚假桥身份，确认结束后清理私有请求", async () => {
  const f = await fixture({
    success: false,
    bridgeEpoch: null,
    applicationRevision: null,
    documents: [],
    version: [],
    error: "observer_unavailable",
  });
  await expect(f.reader.read(f.application, f.context)).rejects.toMatchObject({
    code: "query_failed",
    observationConfirmed: true,
    actionSent: true,
  });
  expect(await readdir(f.root)).toEqual([]);
});

test("名称不同的文档不能共享打开句柄，相同UID不作为去重依据", async () => {
  const first = {
    name: "Part",
    label: "零件",
    fileName: "/outside-task/part.FCStd",
    uid: "same-native-uid",
    modified: false,
    touched: false,
    pendingTransaction: false,
    active: false,
    documentHandle: "28686cba-59d6-44c3-a30c-bbca88a7d737",
    revision: 1,
  };
  const duplicate = await fixture({
    documents: [first, { ...first, name: "Part002" }],
  });
  await expect(
    duplicate.reader.read(duplicate.application, duplicate.context),
  ).rejects.toMatchObject({
    code: "query_failed",
    observationConfirmed: true,
  });
  const distinct = await fixture({
    documents: [
      first,
      {
        ...first,
        name: "Part002",
        documentHandle: "b53b5e19-a3af-4cba-8ca4-707aacdb0431",
      },
    ],
  });
  expect(
    (await distinct.reader.read(distinct.application, distinct.context))
      .documents,
  ).toHaveLength(2);
});

test("回执完成后应用代际变化，拒绝发布该快照", async () => {
  const f = await fixture();
  f.probe.verify
    .mockImplementationOnce(async () => f.application)
    .mockRejectedValueOnce(
      new CadGuiProbeError("application_changed", "changed"),
    );
  await expect(f.reader.read(f.application, f.context)).rejects.toMatchObject({
    code: "query_failed",
    observationConfirmed: true,
  });
  expect(await readdir(f.root)).toEqual([]);
});

test("预取消不派发；发送后无ACK则有界超时且不重发、不删排队宏", async () => {
  const cancelled = await fixture();
  cancelled.controller.abort();
  await expect(
    cancelled.reader.read(cancelled.application, cancelled.context),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(cancelled.send).not.toHaveBeenCalled();
  expect(await readdir(cancelled.root)).toEqual([]);
  const f = await fixture();
  let macro = "";
  f.send.mockImplementation(async (_application, path) => {
    macro = path;
  });
  await expect(
    f.reader.read(f.application, { ...f.context, timeoutMs: 200 }),
  ).rejects.toMatchObject({
    code: "query_timeout",
    actionSent: true,
    observationConfirmed: false,
  });
  expect(f.send).toHaveBeenCalledOnce();
  await expect(access(macro)).resolves.toBeUndefined();
  await expect(
    access(join(dirname(macro), "cancelled")),
  ).resolves.toBeUndefined();
});

test("确定未发送的peer拒绝可清理临时请求", async () => {
  const f = await fixture();
  f.send.mockRejectedValue(
    new CadGuiTransportError("application_changed", "wrong peer", false),
  );
  await expect(f.reader.read(f.application, f.context)).rejects.toMatchObject({
    code: "query_failed",
    actionSent: false,
  });
  expect(await readdir(f.root)).toEqual([]);
});

test("调用方在发送完成后取消，不重发并保留排队宏与取消标志", async () => {
  const f = await fixture();
  let macroPath = "";
  let observeSend!: () => void;
  const sent = new Promise<void>((resolve) => {
    observeSend = resolve;
  });
  f.send.mockImplementation(async (_application, path) => {
    macroPath = path;
    observeSend();
  });
  const reading = f.reader.read(f.application, f.context);
  const outcome = reading.catch((error: unknown) => error);
  await sent;
  // 等真实 send Promise 完成，明确覆盖已送达后取消，而不是发送中取消。
  const delivery = f.send.mock.results[0];
  if (delivery?.type !== "return")
    throw new Error("发送夹具没有返回完成 Promise");
  await delivery.value;
  f.controller.abort(new Error("caller cancelled after delivery"));
  expect(await outcome).toMatchObject({
    code: "cancelled",
    actionSent: true,
    observationConfirmed: false,
  });
  expect(f.send).toHaveBeenCalledOnce();
  expect(f.probe.verify).toHaveBeenCalledOnce();
  expect((await stat(macroPath)).mode & 0o777).toBe(0o600);
  expect(await readFile(join(dirname(macroPath), "cancelled"), "utf8")).toBe(
    "cancelled",
  );
});

test("发送结果未知时保留固定宏与取消标志，不当成确定未发送清理", async () => {
  const f = await fixture();
  let macroPath = "";
  f.send.mockImplementation(async (_application, path) => {
    macroPath = path;
    throw new CadGuiTransportError(
      "transport_failed",
      "unknown delivery",
      undefined,
    );
  });
  await expect(f.reader.read(f.application, f.context)).rejects.toMatchObject({
    code: "query_failed",
    actionSent: undefined,
    observationConfirmed: false,
  });
  expect(f.send).toHaveBeenCalledOnce();
  await expect(access(macroPath)).resolves.toBeUndefined();
  await expect(
    access(join(dirname(macroPath), "cancelled")),
  ).resolves.toBeUndefined();
});
