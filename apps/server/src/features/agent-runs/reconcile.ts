import type { PersistenceService } from "../persistence/types.js";
import { createAgentRunRepository } from "./repository.js";

/** 对账写入的失败原因（面向用户，和 run 级失败文案同一条口径）。 */
export const INTERRUPTED_RUN_MESSAGE =
  "服务重启，本轮已中断（进程在生成过程中退出，未有终态事件）。";

/**
 * 孤儿 run 对账：把**本进程启动前**遗留的非终态 run 收敛成 `failed` 终态。
 *
 * 为什么需要：run 的行只在本进程内存里推进——进程被重启/杀掉时没人写终态，行就
 * 永远停在 `running`，客户端于是永远「生成中」（实测复现过）。
 *
 * **必须由「真正开始服务的进程」调用**，故挂在入口 `listen` 成功之后，而不是插件的
 * `mounted`：开发态可能同时跑着两条 server 链，抢不到端口的那条也会走完装配——
 * 如果由它执行对账，就会把**正在服务的那条进程**在飞的 run 误判成孤儿（实测踩中：
 * 一条刚起的 run 被抢端口失败的另一条链收成了 failed，而它其实跑得好好的）。
 * 判据因此收敛成「我绑上了端口 = 我是这批 run 的属主」。
 *
 * 失败不阻断启动（对账是兜底，不是启动前置条件）。
 */
export async function reconcileInterruptedRuns(
  persistence: PersistenceService,
  bootAt: Date,
): Promise<number> {
  return createAgentRunRepository(persistence).reconcileInterrupted(
    bootAt,
    INTERRUPTED_RUN_MESSAGE,
  );
}
