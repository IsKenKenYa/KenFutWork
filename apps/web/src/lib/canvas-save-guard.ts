/**
 * 画布「空场景覆盖」护栏（两条写路径共用）。
 *
 * 为什么需要它：Excalidraw 挂载/水合完成前可能先回调一次**空元素列表**，而画布保存是
 * **整表替换**（FULL REPLACE）——这一次空保存会把服务端已有内容清空。实测发生过一次
 * （画好的 7 个元素先落库，随后被 103 字节的空内容覆盖），埋点也抓到画布页在挂载后确实
 * 会发出一次 107 字节的空场景 PUT。
 *
 * 一个坑不能修补两处：卸载前 flush（`buildSavePayload`）本来就有这条判定，而防抖自动
 * 保存（`handleChange`）没有——空保存正是从后者漏出去的。所以判定收敛到这个纯函数，
 * 两条路径共用，避免再次各自漂移。
 *
 * 取舍：**宁可拒绝写入也不清空内容**——用户把画布元素删光时这次保存也会被挡下，
 * 画布内容留在服务端（下次带内容的保存照常覆盖）。相比「一次竞态把用户的作品清空」，
 * 这个方向的代价小得多。
 */
export function shouldRefuseEmptySave(input: {
  /** 本次要写入的元素数（已剔除 isDeleted）。 */
  incomingCount: number;
  /** 挂载时服务端已有的元素数（本次会话的基线）。 */
  loadedCount: number;
}): boolean {
  return input.incomingCount === 0 && input.loadedCount > 0;
}
