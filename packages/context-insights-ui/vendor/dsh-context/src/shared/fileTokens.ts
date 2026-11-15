import { estimateTextTokens } from './estimate'

const DIGEST_PREFIX_LENGTH = 'sha256:'.length
const DIGEST_SHOWN = 8

export function estimateFileTokens(ref: { attachmentId: string; name?: string; bytes?: number }): number | null {
  if (ref.name === undefined || ref.bytes === undefined) return null
  const digest = ref.attachmentId.slice(DIGEST_PREFIX_LENGTH, DIGEST_PREFIX_LENGTH + DIGEST_SHOWN)
  const identity = `File ${JSON.stringify(ref.name)} (${ref.bytes} bytes, sha256:${digest})`
  const handle = `[${identity} was uploaded, but the current execution environment cannot access a`
    + ' readable path. Report that limitation if its contents are needed; do not claim to have read it.]'
  return estimateTextTokens(handle)
}
