/**
 * zcode 照搬：`@/lib/interfaceMode.ts`（references/zcode/packages/ui/src/lib/interfaceMode.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */
export type InterfaceMode = "office" | "coding";

export const INTERFACE_MODE_STORAGE_KEY = "zcode-interface-mode";

export function normalizeInterfaceMode(value: unknown): InterfaceMode {
  // localStorage（zcode-interface-mode）里可能还存着改名前的旧值 "general"/"concise"，
  // 必须映射到新名 office，否则这些存量用户升级后会被归一成 coding，静默丢失选择。
  return value === "office" || value === "general" || value === "concise"
    ? "office"
    : "coding";
}
