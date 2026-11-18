import type { CanvasContent } from "@kenfutwork/shared";
import {
  initialCanvasFileReferences,
  serializeCanvasSaveContent,
} from "./canvas-save-session";

export interface CanvasDraftScope {
  projectId: string;
  canvasId: string;
  clientId: string;
}

export interface CanvasDraftInput {
  generation: number;
  content: CanvasContent;
  base: {
    revision: string;
    content: CanvasContent;
    /** 同一确认快照在 Excalidraw hydrate 后的本地表示。 */
    localContent?: CanvasContent;
  };
  submitted: { revision: string; sceneKey: string } | null;
}

export type CanvasDraft = CanvasDraftScope &
  CanvasDraftInput & { token: string };
type DraftRecord = CanvasDraftScope & {
  generation: number;
  draft: CanvasDraft | null;
};

function durableContent(content: CanvasContent): CanvasContent {
  const snapshot = serializeCanvasSaveContent(
    content,
    initialCanvasFileReferences(content.files),
  );
  for (const file of Object.values(snapshot.files)) {
    if (typeof file.dataURL === "string" && !file.dataURL.startsWith("data:"))
      delete file.dataURL;
  }
  return snapshot;
}

/** 每个客户端一份草稿；清稿保留代际水位，迟到写入不能使旧草稿复活。 */
export function createCanvasDraftStore(
  options: { indexedDB?: IDBFactory; databaseName?: string } = {},
) {
  let opening: Promise<IDBDatabase> | null = null;
  const database = () => {
    if (opening) return opening;
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const factory = options.indexedDB ?? globalThis.indexedDB;
      if (!factory) throw new Error("本地草稿存储不可用");
      const request = factory.open(
        options.databaseName ?? "kenfutwork-canvas-drafts",
        1,
      );
      let blocked = false;
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("drafts", {
          keyPath: ["projectId", "canvasId", "clientId"],
        });
        store.createIndex("document", ["projectId", "canvasId"]);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        blocked = true;
        reject(new Error("本地草稿存储正被其他页面占用"));
      };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) return db.close();
        db.onversionchange = () => db.close();
        resolve(db);
      };
    });
    return opening;
  };

  const transaction = async <T>(
    mode: IDBTransactionMode,
    apply: (store: IDBObjectStore, result: (value: T) => void) => void,
  ): Promise<T> => {
    const db = await database();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction("drafts", mode);
      let result: T;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error ?? new Error("本地草稿未写入"));
      tx.onerror = () => reject(tx.error);
      apply(tx.objectStore("drafts"), (value) => {
        result = value;
      });
    });
  };

  return {
    async write(
      scope: CanvasDraftScope,
      input: CanvasDraftInput,
    ): Promise<CanvasDraft | null> {
      const captured = structuredClone({ ...scope, ...input });
      captured.content = durableContent(captured.content);
      captured.base.content = durableContent(captured.base.content);
      if (captured.base.localContent)
        captured.base.localContent = durableContent(captured.base.localContent);
      const draft: CanvasDraft = { ...captured, token: crypto.randomUUID() };
      const capturedScope: CanvasDraftScope = {
        projectId: captured.projectId,
        canvasId: captured.canvasId,
        clientId: captured.clientId,
      };
      return transaction<CanvasDraft | null>("readwrite", (store, result) => {
        const request = store.get([
          capturedScope.projectId,
          capturedScope.canvasId,
          capturedScope.clientId,
        ]);
        request.onsuccess = () => {
          const previous = request.result as DraftRecord | undefined;
          if (previous && previous.generation >= draft.generation)
            return result(null);
          store.put({
            ...capturedScope,
            generation: draft.generation,
            draft,
          } satisfies DraftRecord);
          result(draft);
        };
      });
    },
    async list(
      scope: Pick<CanvasDraftScope, "projectId" | "canvasId">,
    ): Promise<CanvasDraft[]> {
      const key = [scope.projectId, scope.canvasId];
      return transaction("readonly", (store, result) => {
        const request = store.index("document").getAll(key);
        request.onsuccess = () =>
          result(
            (request.result as DraftRecord[]).flatMap((record) =>
              record.draft ? [record.draft] : [],
            ),
          );
      });
    },
    async acknowledge(
      scope: CanvasDraftScope,
      token: string,
    ): Promise<boolean> {
      const key = [scope.projectId, scope.canvasId, scope.clientId];
      return transaction("readwrite", (store, result) => {
        const request = store.get(key);
        request.onsuccess = () => {
          const record = request.result as DraftRecord | undefined;
          if (!record?.draft || record.draft.token !== token)
            return result(false);
          store.put({ ...record, draft: null });
          result(true);
        };
      });
    },
    async close() {
      if (!opening) return;
      const pending = opening;
      opening = null;
      await pending.then(
        (db) => db.close(),
        () => {},
      );
    },
  };
}
