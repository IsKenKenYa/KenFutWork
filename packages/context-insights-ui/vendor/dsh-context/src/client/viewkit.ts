import type { ContextEventRecord } from '../shared/types'
import { useSyncExternalStore } from 'react'
import { fmt, fmtDuration, fmtShare, fmtTime } from './format'
import { makeEventText, type EventLabelParts } from './components/events'
import type { Translate } from './i18n'
import type { LocaleService } from './services'

export interface ViewKit {
  t: Translate
  fmt: typeof fmt
  fmtTime: typeof fmtTime
  fmtDuration: typeof fmtDuration
  fmtShare: typeof fmtShare
  catLabel: (key: string) => string
  eventLabel: (ev: ContextEventRecord) => string
  eventLabelParts: (ev: ContextEventRecord) => EventLabelParts
  eventAt: (ev: ContextEventRecord) => string | null
  useLocaleTick(): void
}

const noopLocaleTick = (): void => {}

export function makeViewKit(t: Translate, locale?: LocaleService): ViewKit {
  const { eventLabel, eventLabelParts, eventAt } = makeEventText(t)
  const subscribe = locale !== undefined && typeof locale.subscribe === 'function' ? locale.subscribe.bind(locale) : undefined
  const useLocaleTick = subscribe === undefined
    ? noopLocaleTick
    : (): void => {
      useSyncExternalStore(subscribe, () => locale?.getLocale?.().active ?? '')
    }
  return {
    t,
    fmt,
    fmtTime,
    fmtDuration,
    fmtShare,
    catLabel: key => t('cat.' + key),
    eventLabel,
    eventLabelParts,
    eventAt,
    useLocaleTick,
  }
}
