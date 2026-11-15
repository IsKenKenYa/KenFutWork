import type { ReactElement, ReactNode } from 'react'

export function Section(props: {
  label: string
  labelClass?: string
  foldHead?: boolean
  headNote?: string
  count?: number
  actions?: ReactNode
  meta?: ReactNode
  children: ReactNode
}): ReactElement {
  const right = props.actions !== undefined || props.meta !== undefined
  return (
    <div className="lc-ts-card">
      <div className={'lc-ts-card-head' + (props.foldHead === true ? ' lc-ts-card-head-wrap' : '')}>
        <b className={props.labelClass} title={props.label}>{props.label}</b>
        {props.headNote ? <span className="lc-ts-card-head-note" title={props.headNote}>{props.headNote}</span> : null}
        {right ? <span className="lc-ts-card-right">{props.meta}{props.actions}</span> : null}
        {props.count !== undefined ? <span className="lc-ts-card-count">{props.count}</span> : null}
      </div>
      {props.children}
    </div>
  )
}
