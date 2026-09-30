/**
 * zcode 移植层宿主适配：内存诊断注册表最小桩。
 * 原版（references/zcode packages/ui/src/lib/memoryDiagnostics.ts）依赖 @zcode/shared 的
 * 诊断注册表 + 60s 采样写桌面日志；我们没有那条链路，这里只保留各模块注册所需的
 * register 面，注册后不再采样（诊断价值在 zcode 桌面端，web 端不落盘）。
 */

type MemoryDiagnosticsProvider = () => Record<string, number | string>;

interface MemoryDiagnosticsRegistry {
  register(name: string, provider: MemoryDiagnosticsProvider): void;
}

const providers = new Map<string, MemoryDiagnosticsProvider>();

export const uiMemoryDiagnosticsRegistry: MemoryDiagnosticsRegistry = {
  register(name, provider) {
    providers.set(name, provider);
  },
};
