"use client";

import type { CanvasSaveResponse } from "@kenfutwork/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type CanvasDraft,
  type CanvasDraftInput,
  createCanvasDraftStore,
} from "../lib/canvas-draft-store";
import {
  initialCanvasFileReferences,
  serializeCanvasSaveContent,
} from "../lib/canvas-save-session";

type DraftReceipt = {
  acknowledge(
    confirmed: Pick<CanvasSaveResponse, "revision" | "fileReferences">,
  ): Promise<void>;
};

/** 只负责本地日志；网络顺序与远端版本仍由 CanvasSaveSession 持有。 */
export function useCanvasDrafts(projectId: string, canvasId: string) {
  const journal = useMemo(
    () => ({
      scope: { projectId, canvasId, clientId: crypto.randomUUID() },
      store: createCanvasDraftStore(),
      disposed: false,
      generation: 0,
      restored: [] as CanvasDraft[],
    }),
    [projectId, canvasId],
  );
  const current = useRef(journal);
  current.current = journal;
  const [loaded, setLoaded] = useState(() => !globalThis.indexedDB);
  const [drafts, setDrafts] = useState<CanvasDraft[]>([]);
  const [error, setError] = useState<string | null>(() =>
    globalThis.indexedDB ? null : "本地草稿不可用，关闭前请保存或导出",
  );

  useEffect(() => {
    journal.disposed = false;
    if (!globalThis.indexedDB)
      return () => {
        journal.disposed = true;
      };
    let active = true;
    journal.store.list(journal.scope).then(
      (saved) => {
        if (!active) return;
        setDrafts(saved);
        setLoaded(true);
      },
      () => {
        if (!active) return;
        setError("本地草稿不可用，关闭前请保存或导出");
        setLoaded(true);
      },
    );
    return () => {
      active = false;
      journal.disposed = true;
      // close 等待已有事务完成；迟到网络 ACK 可自行重新打开连接。
      void journal.store.close();
    };
  }, [journal]);

  const operations = useMemo(() => {
    let latest: CanvasDraftInput | null = null;
    let submitted: CanvasDraftInput["submitted"] = null;
    let acknowledgedGeneration = 0;
    const reportFailure = () => {
      if (current.current === journal && !journal.disposed)
        setError("本地草稿未保存，关闭前请保存或导出");
    };
    const acknowledgeDrafts = async (saved: CanvasDraft[]) => {
      await Promise.all(
        saved.map((draft) => journal.store.acknowledge(draft, draft.token)),
      );
      const tokens = new Set(saved.map((draft) => draft.token));
      journal.restored = journal.restored.filter(
        (draft) => !tokens.has(draft.token),
      );
      if (current.current === journal && !journal.disposed)
        setDrafts((drafts) =>
          drafts.filter((draft) => !tokens.has(draft.token)),
        );
    };
    const write = (
      input: Omit<CanvasDraftInput, "generation">,
      inheritSubmitted = true,
    ): DraftReceipt => {
      // 同一 CAS 代际最多一个请求能提交；网络失败不等于服务端未提交。
      // 重试不能抹掉该代际最早仍可能迟到的场景，否则 A→B→A 会失去反转意图。
      if (input.submitted && submitted?.revision !== input.submitted.revision)
        submitted = input.submitted;
      const snapshot: CanvasDraftInput = structuredClone({
        ...input,
        submitted: inheritSubmitted ? submitted : input.submitted,
        generation: ++journal.generation,
      });
      latest = snapshot;
      const recovered = [...journal.restored];
      const written = journal.store
        .write(journal.scope, snapshot)
        .catch(() => {
          reportFailure();
          return null;
        })
        .finally(() => {
          if (journal.disposed) void journal.store.close();
        });
      return {
        async acknowledge(
          confirmed: Pick<CanvasSaveResponse, "revision" | "fileReferences">,
        ) {
          const draft = await written;
          if (!draft) return;
          try {
            if (snapshot.generation > acknowledgedGeneration) {
              acknowledgedGeneration = snapshot.generation;
              if (
                submitted?.sceneKey === snapshot.submitted?.sceneKey &&
                submitted?.revision === snapshot.submitted?.revision
              )
                submitted = null;
              if (latest && latest.generation > snapshot.generation) {
                // IDB 的完成回调可迟到于远端接纳；只推进仍以该请求基线编辑的稿。
                const sharesBase =
                  latest.base.revision === snapshot.base.revision;
                const content = sharesBase
                  ? serializeCanvasSaveContent(latest.content, {
                      ...initialCanvasFileReferences(latest.content.files),
                      ...confirmed.fileReferences,
                    })
                  : latest.content;
                write(
                  {
                    content,
                    base: sharesBase
                      ? {
                          revision: confirmed.revision,
                          content: snapshot.content,
                          localContent: snapshot.content,
                        }
                      : latest.base,
                    submitted,
                  },
                  false,
                );
              }
            }
            // 每份稿的 token 都在提交时捕获；旧 ACK 无法清除新代际。
            await acknowledgeDrafts([draft, ...recovered]);
          } catch {
            reportFailure();
          } finally {
            if (journal.disposed) void journal.store.close();
          }
        },
      };
    };
    return {
      restored(saved: CanvasDraft[]) {
        journal.restored = saved;
      },
      async confirmRestored(saved: CanvasDraft[]) {
        try {
          await acknowledgeDrafts(saved);
        } catch {
          reportFailure();
        } finally {
          if (journal.disposed) void journal.store.close();
        }
      },
      write,
    };
  }, [journal]);

  return { loaded, drafts, error, ...operations };
}
