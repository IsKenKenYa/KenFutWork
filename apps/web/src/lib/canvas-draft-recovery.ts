import type { CanvasContent } from "@kenfutwork/shared";
import type { CanvasDraft } from "./canvas-draft-store";
import {
  canvasSceneFromKey,
  canvasSceneKey,
  reconcileCanvasScene,
} from "./canvas-scene-state";

/** 保留所有客户端的原稿；只有能共同三方合并的结果才可接纳。 */
export function recoverCanvasDrafts(
  remote: CanvasContent,
  drafts: CanvasDraft[],
): CanvasContent | null {
  let content = remote;
  for (const draft of drafts) {
    let base = draft.base.content;
    let localBase = draft.base.localContent;
    let submittedScene: ReturnType<typeof canvasSceneFromKey> | null = null;
    if (draft.submitted) {
      try {
        const submitted = canvasSceneFromKey(draft.submitted.sceneKey);
        submittedScene = submitted;
        const applied = reconcileCanvasScene({
          base,
          localBase: localBase ?? base,
          local: submitted,
          remote: content,
        });
        if (!applied) return null;
        // 服务端已接纳请求、客户端没收到 ACK：以已提交的场景恢复随后反转。
        if (canvasSceneKey(applied.merged) === canvasSceneKey(applied.remote)) {
          base = { ...submitted, elements: [...submitted.elements], files: {} };
          localBase = base;
        }
      } catch {
        return null;
      }
    }
    const result = reconcileCanvasScene({
      base,
      localBase: localBase ?? base,
      local: draft.content,
      remote: content,
    });
    if (!result) return null;
    const mergedIds = new Set(
      result.merged.elements.map((element) => element.id),
    );
    const liveIds = new Set(
      draft.content.elements
        .filter((element) => !element.isDeleted)
        .map((element) => element.id),
    );
    // 未落库的旧请求也可能新增元素；保留对它们的显式删除，空意图才可通过同一护栏保存。
    const deletions = (submittedScene?.elements ?? [])
      .filter(
        (element) =>
          !element.isDeleted &&
          !liveIds.has(element.id) &&
          !mergedIds.has(element.id),
      )
      .map((element) => ({ ...element, isDeleted: true }));
    content = {
      ...result.merged,
      elements: [...result.merged.elements, ...deletions],
      files: { ...draft.content.files, ...content.files },
    };
  }
  return content;
}
