/**
 * zcode 移植层宿主适配：`ai` 包 UIMessage 的最小类型等价。
 * zcode message.tsx 只消费 `UIMessage["role"]`（MessageProps.from），
 * 我们不引入整包，只保留角色联合类型。
 */

export interface UIMessage {
  role: "system" | "user" | "assistant" | "data";
}
