import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type CadGuiApplication,
  type CadGuiDocumentInspection,
  type CadGuiDocumentMetadata,
  type CadGuiDocumentsSnapshot,
  type CadGuiInspectDocumentInput,
  cadGuiDocumentsReplySchema,
  cadGuiInspectDocumentInputSchema,
  cadGuiInspectDocumentReplySchema,
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
  inspect(
    input: CadGuiInspectDocumentInput,
    context: CadGuiProbeContext,
  ): Promise<CadGuiDocumentInspection>;
}

export class CadGuiDocumentQueryError extends Error {
  constructor(
    readonly code:
      | "query_failed"
      | "query_timeout"
      | "cancelled"
      | "stale_target"
      | "object_missing",
    message: string,
    readonly requestId: string,
    readonly actionSent: boolean | undefined,
    readonly observationConfirmed: boolean,
  ) {
    super(message);
    this.name = "CadGuiDocumentQueryError";
  }
}

type QueryOperation =
  | { operation: "list-document-metadata" }
  | ({ operation: "inspect-document" } & Omit<
      CadGuiInspectDocumentInput,
      "application"
    >);

async function readReply(
  path: string,
  maxBytes: number,
  operation: QueryOperation["operation"],
) {
  try {
    if ((await stat(path)).size > maxBytes)
      throw new Error("文档清单超过输出上限");
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return operation === "inspect-document"
      ? cadGuiInspectDocumentReplySchema.parse(value)
      : cadGuiDocumentsReplySchema.parse(value);
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

async function prepareRequestFiles(
  files: QueryFiles,
  request: QueryRequest & QueryOperation,
) {
  await writeFile(files.requestPath, JSON.stringify(request), {
    flag: "wx",
    mode: 0o600,
  });
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
  operation: QueryOperation["operation"],
) {
  for (;;) {
    signal.throwIfAborted();
    const reply = await readReply(replyPath, context.maxOutputBytes, operation);
    if (reply) {
      if (reply.requestId !== requestId || reply.pid !== application.pid)
        throw new Error("文档查询回执身份不匹配");
      return reply;
    }
    await delay(20, undefined, { signal });
  }
}

function assertDocumentIdentities(reply: {
  documents: CadGuiDocumentMetadata[];
}) {
  const names = new Set(reply.documents.map((document) => document.name));
  const handles = new Set(
    reply.documents.map((document) => document.documentHandle),
  );
  if (
    names.size !== reply.documents.length ||
    handles.size !== reply.documents.length ||
    reply.documents.filter((document) => document.active).length > 1
  )
    throw new Error("文档清单身份重复");
}

function assertInspectionTarget(
  reply: CadGuiDocumentInspection,
  input: CadGuiInspectDocumentInput,
) {
  if (
    reply.bridgeEpoch !== input.bridgeEpoch ||
    reply.applicationRevision !== input.expectedApplicationRevision ||
    reply.document.documentHandle !== input.documentHandle ||
    reply.document.revision !== input.expectedDocumentRevision
  )
    throw new Error("文档结构回执与指定快照不一致");
  const names = new Set(reply.objects.map((object) => object.name));
  if (
    names.size !== reply.objects.length ||
    (input.objectNames &&
      (names.size !== input.objectNames.length ||
        input.objectNames.some((name) => !names.has(name))))
  )
    throw new Error("文档对象清单与指定对象不一致");
  for (const object of reply.objects) {
    if (
      (!input.objectNames && object.properties !== undefined) ||
      (input.objectNames && object.properties === undefined) ||
      (object.properties &&
        new Set(object.properties.map((property) => property.name)).size !==
          object.properties.length)
    )
      throw new Error("文档属性清单与请求不一致");
  }
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

type SuccessfulQueryReply = Extract<
  NonNullable<Awaited<ReturnType<typeof readReply>>>,
  { success: true }
>;

function rejectedQuery(
  code: string | undefined,
  requestId: string,
  actionSent: boolean | undefined,
) {
  if (code === "stale_target" || code === "object_missing") {
    const message =
      code === "stale_target"
        ? "FreeCAD 文档已改变，请重新读取文档清单后再检查。"
        : "指定的 FreeCAD 对象已不存在，请重新读取对象清单。";
    return new CadGuiDocumentQueryError(
      code,
      message,
      requestId,
      actionSent,
      true,
    );
  }
  return new Error("FreeCAD 未完成文档查询");
}

export function createMacosCadGuiDocumentReader(options: {
  probe: CadGuiProbe;
  transport?: CadGuiMacroTransport;
  rootDirectory?: string;
}): CadGuiDocumentReader {
  const transport = options.transport ?? createMacosCadGuiTransport();
  const query = async <T>(
    application: CadGuiApplication,
    context: CadGuiProbeContext,
    operation: QueryOperation,
    project: (
      reply: SuccessfulQueryReply,
      verified: CadGuiApplication,
      requestId: string,
    ) => T,
  ): Promise<T> => {
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
      const request = {
        ...operation,
        requestId,
        pid: application.pid,
        expiresAt,
      };
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
        operation.operation,
      );
      observationConfirmed = true;
      if (!reply.success)
        throw rejectedQuery(reply.error, requestId, actionSent);
      const verified = await options.probe.verify(application, active());
      signal.throwIfAborted();
      return project(reply, verified, requestId);
    } catch (error) {
      if (error instanceof CadGuiTransportError) actionSent = error.actionSent;
      if (error instanceof CadGuiDocumentQueryError) throw error;
      throw queryFailure(context, timeout.signal, {
        requestId,
        actionSent,
        observationConfirmed,
      });
    } finally {
      clearTimeout(timer);
      await cleanupRequest(files, actionSent, observationConfirmed);
    }
  };
  return {
    async read(application, context) {
      return query(
        application,
        context,
        { operation: "list-document-metadata" },
        (reply, verified, requestId) => {
          if (reply.protocol !== "kfw-cad-gui-query/2")
            throw new Error("文档查询回执类型不匹配");
          assertDocumentIdentities(reply);
          return {
            application: verified,
            observationId: requestId,
            bridgeEpoch: reply.bridgeEpoch,
            applicationRevision: reply.applicationRevision,
            version: reply.version,
            documents: reply.documents,
          };
        },
      );
    },
    async inspect(input, context) {
      const parsed = cadGuiInspectDocumentInputSchema.parse(input);
      const { application, ...target } = parsed;
      return query(
        application,
        context,
        { operation: "inspect-document", ...target },
        (reply, verified, requestId) => {
          if (reply.protocol !== "kfw-cad-gui-inspect/1")
            throw new Error("文档结构回执类型不匹配");
          const inspection = {
            application: verified,
            observationId: requestId,
            bridgeEpoch: reply.bridgeEpoch,
            applicationRevision: reply.applicationRevision,
            version: reply.version,
            document: reply.document,
            objects: reply.objects,
          };
          assertInspectionTarget(inspection, parsed);
          return inspection;
        },
      );
    },
  };
}
