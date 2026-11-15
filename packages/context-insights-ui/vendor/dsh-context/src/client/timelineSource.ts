// KenFutWork 修改：仅保留数据回调类型；读取由受保护的宿主 RPC 实现。
import type { ContextDelta } from '../shared/delta'
export type DeltaFetcher = (seq: number | null, baseSeq: number | null) => Promise<ContextDelta | null>
export type DetailState = 'legacy' | 'loading' | 'ready' | 'failed'
