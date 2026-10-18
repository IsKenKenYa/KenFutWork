import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type CadGuiApplication,
  type CadGuiDocumentsSnapshot,
  cadGuiDocumentsReplySchema,
} from "./gui-document-contracts.js";
import { CAD_GUI_DOCUMENT_QUERY_SOURCE } from "./gui-document-source.js";
import type { CadGuiProbe, CadGuiProbeContext } from "./gui-probe.js";
import { CadGuiProbeError } from "./gui-probe.js";
import {
  type CadGuiMacroTransport,
  CadGuiTransportError,
  createMacosCadGuiTransport,
} from "./gui-transport.js";

export interface CadGuiDocumentReader {
  read(
    application: CadGuiApplication,
    context: CadGuiProbeContext,
  ): Promise<CadGuiDocumentsSnapshot>;
}

export class CadGuiDocumentQueryError extends Error {
  constructor(
    readonly code: "query_failed" | "query_timeout" | "cancelled",
    message: string,
    readonly requestId: string,
    readonly actionSent: boolean | undefined,
    readonly observationConfirmed: boolean,
  ) {
    super(message);
    this.name = "CadGuiDocumentQueryError";
  }
}

async function readReply(path: string, maxBytes: number) {
  try {
    if ((await stat(path)).size > maxBytes)
      throw new Error("文档清单超过输出上限");
    return cadGuiDocumentsReplySchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

interface QueryRequest {
  requestId: string;
  pid: number;
  expiresAt: number;
}

interface QueryFiles {
  directory: string;
  requestPath: string;
  replyPath: string;
  cancelledPath: string;
  macroPath: string;
}

async function createRequestDirectory(
  rootDirectory?: string,
): Promise<QueryFiles> {
  const directory = await mkdtemp(
    join(rootDirectory ?? tmpdir(), "kfw-cad-gui-query-"),
  );
  return {
    directory,
    requestPath: join(directory, "request.json"),
    replyPath: join(directory, "reply.json"),
    cancelledPath: join(directory, "cancelled"),
    macroPath: join(directory, "query.FCMacro"),
  };
}

async function prepareRequestFiles(files: QueryFiles, request: QueryRequest) {
  await writeFile(
    files.requestPath,
    JSON.stringify({ operation: "list-document-metadata", ...request }),
    { flag: "wx", mode: 0o600 },
  );
  const macro =
    CAD_GUI_DOCUMENT_QUERY_SOURCE +
    `\n_kfw_cad_query_documents(${JSON.stringify(files.requestPath)}, ${JSON.stringify(files.replyPath)}, ${JSON.stringify(files.cancelledPath)})\n`;
  await writeFile(files.macroPath, macro, { flag: "wx", mode: 0o600 });
}

async function readMatchingReply(
  replyPath: string,
  requestId: string,
  application: CadGuiApplication,
  context: CadGuiProbeContext,
  signal: AbortSignal,
) {
  for (;;) {
    signal.throwIfAborted();
    const reply = await readReply(replyPath, context.maxOutputBytes);
    if (reply) {
      if (reply.requestId !== requestId || reply.pid !== application.pid)
        throw new Error("文档查询回执身份不匹配");
      return reply;
    }
    await delay(20, undefined, { signal });
  }
}

function assertDocumentIdentities(
  reply: NonNullable<Awaited<ReturnType<typeof readReply>>>,
) {
  const names = new Set(reply.documents.map((document) => document.name));
  if (
    names.size !== reply.documents.length ||
    reply.documents.filter((document) => document.active).length > 1
  )
    throw new Error("文档清单身份重复");
}

async function cleanupRequest(
  files: QueryFiles | undefined,
  actionSent: boolean | undefined,
  observationConfirmed: boolean,
) {
  if (!files) return;
  if (actionSent === false || observationConfirmed) {
    await rm(files.directory, { recursive: true, force: true });
    return;
  }
  // 无业务ACK时不能删掉已排队的宏路径；保留私有诊断并阻止迟到查询读取文档。
  await writeFile(files.cancelledPath, "cancelled", {
    flag: "wx",
    mode: 0o600,
  }).catch(() => {});
}

function validateContext(context: CadGuiProbeContext) {
  if (
    !Number.isSafeInteger(context.timeoutMs) ||
    context.timeoutMs <= 0 ||
    context.timeoutMs > 2_147_483_647 ||
    !Number.isSafeInteger(context.maxOutputBytes) ||
    context.maxOutputBytes <= 0
  )
    throw new CadGuiProbeError("probe_failed", "文档查询限制无效。");
}

function queryFailure(
  context: CadGuiProbeContext,
  timeout: AbortSignal,
  observation: {
    requestId: string;
    actionSent: boolean | undefined;
    observationConfirmed: boolean;
  },
) {
  const code = context.signal?.aborted
    ? "cancelled"
    : timeout.aborted
      ? "query_timeout"
      : "query_failed";
  const messages = {
    cancelled: "FreeCAD 文档查询已取消。",
    query_timeout: "FreeCAD 文档查询超时，请确认应用未被对话框阻塞。",
    query_failed: "无法查询 FreeCAD 当前文档，请重新查询应用状态后重试。",
  };
  return new CadGuiDocumentQueryError(
    code,
    messages[code],
    observation.requestId,
    observation.actionSent,
    observation.observationConfirmed,
  );
}

export function createMacosCadGuiDocumentReader(options: {
  probe: CadGuiProbe;
  transport?: CadGuiMacroTransport;
  rootDirectory?: string;
}): CadGuiDocumentReader {
  const transport = options.transport ?? createMacosCadGuiTransport();
  return {
    async read(application, context) {
      context.signal?.throwIfAborted();
      validateContext(context);
      const requestId = randomUUID();
      const expiresAt = Date.now() + context.timeoutMs;
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), context.timeoutMs);
      const signal = AbortSignal.any([
        timeout.signal,
        ...(context.signal ? [context.signal] : []),
      ]);
      const active = (): CadGuiProbeContext => ({
        ...context,
        signal,
        timeoutMs: Math.max(1, expiresAt - Date.now()),
      });
      let files: QueryFiles | undefined;
      let actionSent: boolean | undefined = false;
      let observationConfirmed = false;
      try {
        await options.probe.verify(application, active());
        signal.throwIfAborted();
        files = await createRequestDirectory(options.rootDirectory);
        const request = { requestId, pid: application.pid, expiresAt };
        await prepareRequestFiles(files, request);
        signal.throwIfAborted();
        actionSent = undefined;
        await transport.send(application, files.macroPath, active());
        actionSent = true;
        const reply = await readMatchingReply(
          files.replyPath,
          requestId,
          application,
          context,
          signal,
        );
        observationConfirmed = true;
        if (!reply.success) throw new Error("FreeCAD 未完成文档查询");
        const verified = await options.probe.verify(application, active());
        signal.throwIfAborted();
        assertDocumentIdentities(reply);
        return {
          application: verified,
          observationId: requestId,
          version: reply.version,
          documents: reply.documents,
        };
      } catch (error) {
        if (error instanceof CadGuiTransportError)
          actionSent = error.actionSent;
        throw queryFailure(context, timeout.signal, {
          requestId,
          actionSent,
          observationConfirmed,
        });
      } finally {
        clearTimeout(timer);
        await cleanupRequest(files, actionSent, observationConfirmed);
      }
    },
  };
}
