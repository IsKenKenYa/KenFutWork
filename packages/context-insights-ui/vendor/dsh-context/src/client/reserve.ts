export const COMPACT_THRESHOLD_RATIO = 0.8

export const COMPACT_HEADROOM_TOKENS = 65_536

export interface ContextReserve {
  threshold: number
  headroom: number
  output: number
}

export function reserveGeometry(
  window: number | undefined,
  maxOutputTokens: number | undefined,
): ContextReserve | undefined {
  if (window === undefined || !Number.isFinite(window) || window <= 0) return undefined
  const output = Math.min(
    maxOutputTokens !== undefined && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : 0,
    window,
  )
  const pressureBudget = window - output - COMPACT_HEADROOM_TOKENS
  if (pressureBudget <= 0) return undefined
  const threshold = Math.min(Math.floor(window * COMPACT_THRESHOLD_RATIO), pressureBudget)
  return { threshold, headroom: COMPACT_HEADROOM_TOKENS, output }
}
