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

  const blockConflict = (
    error: Error & { code: "canvas_revision_conflict" },
    onConflict?: (error: Error) => void,
  ) => {
    if (blockedBy) return;
    blockedBy = error;
    onConflict?.(error);
  };

  const save = (
    content: CanvasContent,
    send: CanvasSaveSender,
    onConflict?: (error: Error) => void,
  ): Promise<CanvasSaveResponse> => {
    activeSaves++;
    const operation = queue.then(async () => {
      if (blockedBy) throw blockedBy;
      try {
        const result = await send(
          serializeCanvasSaveContent(content, fileReferences, knownFiles),
          revision,
        );
        revision = result.revision;
        fileReferences = { ...fileReferences, ...result.fileReferences };
        knownFiles = {
          ...knownFiles,
          ...content.files,
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
    queue = operation.then(
      () => {
        activeSaves--;
      },
      () => {
        activeSaves--;
      },
    );
    return operation;
  };

  /** beforeunload cannot await the queue; the same CAS makes this race safe. */
  const saveKeepalive = (
    content: CanvasContent,
    send: CanvasSaveSender,
    onConflict?: (error: Error) => void,
  ): void => {
    if (blockedBy) return;
    const expectedRevision = revision;
    activeSaves++;
    void send(
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
      });
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
    conflict,
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
