export type AttachmentKind = 'image' | 'file'

export interface AttachmentRef {
  kind: AttachmentKind
  attachmentId: string
  name?: string
  bytes?: number
  mediaType?: string
  width?: number
  height?: number
  originalDimensions?: { width: number; height: number }
}

const EXTENSION_IMAGE: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg',
])

export function leafNameOf(name: string): string {
  return name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)
}

export function attachmentExtension(name: string): string {
  const base = leafNameOf(name)
  const dot = base.lastIndexOf('.')
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase()
}

export function isImageName(name: string): boolean {
  return EXTENSION_IMAGE.has(attachmentExtension(name))
}

function numOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function dimensionsOf(value: unknown): { width: number; height: number } | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const dims = value as Record<string, unknown>
  const width = numOf(dims.width)
  const height = numOf(dims.height)
  return width !== undefined && height !== undefined ? { width, height } : undefined
}

export function attachmentOf(block: unknown): AttachmentRef | null {
  if (block === null || typeof block !== 'object') return null
  const b = block as { type?: unknown; kind?: unknown; attachment?: unknown }
  const spelling = typeof b.type === 'string' ? b.type : b.kind
  if (spelling !== 'image' && spelling !== 'file') return null
  if (b.attachment === null || typeof b.attachment !== 'object') return null
  const a = b.attachment as Record<string, unknown>
  if (typeof a.attachmentId !== 'string' || a.attachmentId === '') return null
  const name = typeof a.name === 'string' && a.name !== '' ? a.name : undefined
  const bytes = numOf(a.bytes)
  if (spelling === 'file') {
    return {
      kind: 'file',
      attachmentId: a.attachmentId,
      ...(name !== undefined ? { name } : {}),
      ...(bytes !== undefined ? { bytes } : {}),
    }
  }
  const origDims = dimensionsOf(a.originalDimensions)
  const width = numOf(a.width)
  const height = numOf(a.height)
  const mediaType = typeof a.mediaType === 'string' && a.mediaType !== '' ? a.mediaType : undefined
  return {
    kind: 'image',
    attachmentId: a.attachmentId,
    ...(name !== undefined ? { name } : {}),
    ...(mediaType !== undefined ? { mediaType } : {}),
    ...(bytes !== undefined ? { bytes } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(origDims !== undefined ? { originalDimensions: origDims } : {}),
  }
}

export function attachmentsIn(content: unknown): AttachmentRef[] {
  if (!Array.isArray(content)) return []
  const out: AttachmentRef[] = []
  for (const block of content) {
    const ref = attachmentOf(block)
    if (ref !== null) out.push(ref)
  }
  return out
}
