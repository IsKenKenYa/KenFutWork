import type { CanvasContent, CanvasSaveResponse } from "@kenfutwork/shared";

export type CanvasSaveSender = (
  content: CanvasContent,
  expectedRevision: string | null,
) => Promise<CanvasSaveResponse>;

export function isCanvasRevisionConflict(error: unknown): error is Error & {
  code: "canvas_revision_conflict";
} {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "canvas_revision_conflict"
  );
}

export function createCanvasRevisionConflict(message: string) {
  return Object.assign(new Error(message), {
    code: "canvas_revision_conflict" as const,
  });
}

export function initialCanvasFileReferences(
  files: CanvasContent["files"],
): Record<string, string> {
  const references: Record<string, string> = {};
  for (const [fileId, file] of Object.entries(files)) {
    if (typeof file.storageRef === "string" && file.storageRef)
      references[fileId] = file.storageRef;
  }
  return references;
}

/** Keep browser bytes out of later saves after the server returns a stable file reference. */
export function serializeCanvasSaveContent(
  content: CanvasContent,
  fileReferences: Record<string, string>,
  knownFiles: CanvasContent["files"] = {},
): CanvasContent {
  const files: CanvasContent["files"] = {};
  const fileIds = new Set([
    ...Object.keys(knownFiles),
    ...Object.keys(content.files),
  ]);
  for (const fileId of fileIds) {
    const file = { ...knownFiles[fileId], ...content.files[fileId] };
    const metadata = { ...file };
    delete metadata.dataURL;
    delete metadata.storageUrl;
    delete metadata.storageRef;
    const storageRef = fileReferences[fileId];
    files[fileId] = storageRef
      ? { ...metadata, storageRef }
      : {
          ...metadata,
          ...(typeof file.dataURL === "string"
            ? { dataURL: file.dataURL }
            : {}),
        };
  }
  return { ...content, files };
}

/** One canvas revision chain. Queued saves read revision and file references when sent. */
export function createCanvasSaveSession(initial: {
  revision: string | null;
  fileReferences: Record<string, string>;
  files?: CanvasContent["files"];
}) {
  let revision = initial.revision;
  let fileReferences = { ...initial.fileReferences };
  let knownFiles = { ...(initial.files ?? {}) };
  let blockedBy: unknown;
  let queue: Promise<void> = Promise.resolve();
  let activeSaves = 0;
  const operations = new Set<Promise<unknown>>();
  const remoteWindows = new Set<symbol>();
  let remoteSettled: Promise<void> | null = null;
  let finishRemote: (() => void) | null = null;

  /** 窗口内的新保存等待接纳；已发送的保存仍先完成，不能与等待中的保存互锁。 */
  const beginRemoteSnapshot = () => {
    const token = Symbol();
    remoteWindows.add(token);
    if (!remoteSettled) {
      remoteSettled = new Promise<void>((resolve) => {
        finishRemote = resolve;
      });
    }
    return () => {
      if (!remoteWindows.delete(token) || remoteWindows.size > 0) return;
      const finish = finishRemote;
      remoteSettled = null;
      finishRemote = null;
      finish?.();
    };
  };

  const blockConflict = (
    error: Error & { code: "canvas_revision_conflict" },
    onConflict?: (error: Error) => void,
  ) => {
    if (blockedBy) return;
    blockedBy = error;
    onConflict?.(error);
  };

  const save = (
    content: CanvasContent | (() => CanvasContent),
    send: CanvasSaveSender,
    onConflict?: (error: Error) => void,
  ): Promise<CanvasSaveResponse> => {
    if (remoteSettled)
      return remoteSettled.then(() => save(content, send, onConflict));
    activeSaves++;
    const operation = queue.then(async () => {
      if (blockedBy) throw blockedBy;
      try {
        const snapshot = typeof content === "function" ? content() : content;
        const result = await send(
          serializeCanvasSaveContent(snapshot, fileReferences, knownFiles),
          revision,
        );
        revision = result.revision;
        fileReferences = { ...fileReferences, ...result.fileReferences };
        knownFiles = {
          ...knownFiles,
          ...snapshot.files,
        };
        for (const [fileId, storageRef] of Object.entries(
          result.fileReferences,
        )) {
          knownFiles[fileId] = {
            ...knownFiles[fileId],
            storageRef,
          };
        }
        return result;
      } catch (error) {
        if (isCanvasRevisionConflict(error)) blockConflict(error, onConflict);
        throw error;
      }
    });
    operations.add(operation);
    queue = operation.then(
      () => {
        activeSaves--;
        operations.delete(operation);
      },
      () => {
        activeSaves--;
        operations.delete(operation);
      },
    );
    return operation;
  };

  /** beforeunload cannot await the queue; the same CAS makes this race safe. */
  const saveKeepalive = (
    content: CanvasContent,
    send: CanvasSaveSender,
    onConflict?: (error: Error) => void,
  ): boolean => {
    if (blockedBy || remoteSettled) return false;
    const expectedRevision = revision;
    activeSaves++;
    const operation = send(
      serializeCanvasSaveContent(content, fileReferences, knownFiles),
      expectedRevision,
    )
      .then((result) => {
        if (revision === expectedRevision) revision = result.revision;
        fileReferences = { ...fileReferences, ...result.fileReferences };
        knownFiles = { ...knownFiles, ...content.files };
        for (const [fileId, storageRef] of Object.entries(
          result.fileReferences,
        )) {
          knownFiles[fileId] = {
            ...knownFiles[fileId],
            storageRef,
          };
        }
      })
      .catch((error: unknown) => {
        if (isCanvasRevisionConflict(error)) blockConflict(error, onConflict);
      })
      .finally(() => {
        activeSaves--;
        operations.delete(operation);
      });
    operations.add(operation);
    return true;
  };

  const acceptRemoteSnapshot = (snapshot: {
    revision: string;
    fileReferences: Record<string, string>;
    files: CanvasContent["files"];
  }): boolean => {
    if (blockedBy || activeSaves > 0) return false;
    revision = snapshot.revision;
    fileReferences = { ...snapshot.fileReferences };
    knownFiles = { ...snapshot.files };
    return true;
  };

  const conflict = (message: string, onConflict?: (error: Error) => void) =>
    blockConflict(createCanvasRevisionConflict(message), onConflict);

  return {
    save,
    saveKeepalive,
    acceptRemoteSnapshot,
    beginRemoteSnapshot,
    async waitForIdle() {
      await Promise.allSettled([...operations]);
    },
    conflict,
    get isAcceptingRemote() {
      return remoteSettled !== null;
    },
    get isIdle() {
      return activeSaves === 0;
    },
    get revision() {
      return revision;
    },
    get fileReferences() {
      return { ...fileReferences };
    },
    get knownFiles() {
      return { ...knownFiles };
    },
  };
}
