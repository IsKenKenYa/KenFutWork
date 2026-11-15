// KenFutWork 修改：从 dshFaces/seats 提取组件所需的类型，不装配 DSH 宿主服务。
import type { AttachmentRef } from '../shared/attachment'
import type { HeaderEpochContent } from '../shared/types'
import type { ConversationNodeLike } from './seats'
export type { ConversationNodeLike } from './seats'
export interface LocaleService {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  bind(ns: string): (key: string, params?: Record<string, string | number>) => string
  getLocale?(): { active: string }
  subscribe?(listener: () => void): () => void
}
export interface ImageRefLike {
  attachmentId: string
  name?: string
  bytes?: number
  width?: number
  height?: number
  originalDimensions?: { width: number; height: number }
}
export type ImageLoader = (attachment: ImageRefLike) => Promise<string>
export type AttachmentOpener = (attachment: AttachmentRef) => Promise<boolean>
export type ContentFetcher = (seq: number) => Promise<ConversationNodeLike | null>
export type HeaderFetcher = (seq: number) => Promise<HeaderEpochContent | null>
