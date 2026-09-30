/**
 * zcode 宿主适配 stub：`@/v4/sessionDataLayer.ts` 的类型切片。
 * 来源：references/zcode/packages/ui/src/v4/sessionDataLayer.ts
 * 许可证：Apache-2.0（zcode）。
 *
 * SessionDataLayer 是 v4 会话纯数据层（Map<topic, SessionStore>，引用计数订阅，
 * keep-warm 退订），完整实现依赖注入的 ConversationTransport 与 projection store。
 * 本仓没有会话传输实现（数据层整体 stub），故只保留 pane 租约的类型切片
 * （消费方仅触达 sessionId 与 release）。
 * 消费方：app-shell/SubagentDirectorySidePane（SessionLease）。
 */

/** pane 持有的租约；release 幂等（切片：仅保留消费方触达的成员）。 */
export interface SessionLease {
  readonly sessionId: string;
  release(): void;
}
