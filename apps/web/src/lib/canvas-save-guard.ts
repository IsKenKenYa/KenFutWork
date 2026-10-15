/** 空数组可能来自尚未加载的编辑器；显式删除则由 Excalidraw 的删除元素证明。 */
export function shouldRefuseEmptySave(input: {
  /** 本次要写入的元素数（已剔除 isDeleted）。 */
  incomingCount: number;
  deletedCount?: number;
}): boolean {
  return input.incomingCount === 0 && !input.deletedCount;
}
