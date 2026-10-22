/**
 * Shared presentational primitives: cards, badges, async state views, tables,
 * pagination, dialogs/drawers with focus management, and hand-rolled SVG charts.
 *
 * Nothing here invents data: a missing metric renders `—` (or `unknown`) and a
 * missing collection renders an explicit empty state.
 */
import { useCallback, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, ChangeEvent, KeyboardEvent, ReactNode } from 'react'
import { ApiError } from '../api'
import { formatNumber, type MessageKey } from '../i18n'
import { useFocusTrap, type Resource } from '../hooks'
import { useApp } from '../store'
import type { JobStatus, MemoryStatus } from '../types'

/* ------------------------------------------------------------------ */
/* Icons                                                               */
/* ------------------------------------------------------------------ */

export type IconName =
  | 'overview'
  | 'memories'
  | 'evidence'
  | 'conflicts'
  | 'agents'
  | 'capture'
  | 'usage'
  | 'settings'
  | 'diagnostics'
  | 'check'
  | 'alert'
  | 'clock'
  | 'dot'
  | 'history'
  | 'arrow-right'
  | 'cross'
  | 'trash'
  | 'menu'
  | 'pause'
  | 'play'
  | 'globe'
  | 'sun'
  | 'moon'
  | 'refresh'
  | 'external'
  | 'download'

const ICON_PATHS: Record<IconName, string> = {
  overview: 'M3 12h6V3H3zM15 21h6v-9h-6zM3 21h6v-5H3zM15 9h6V3h-6z',
  memories: 'M4 5h16v3H4zM4 10.5h16v3H4zM4 16h10v3H4z',
  evidence: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 7v10',
  conflicts: 'M6 4l12 16M18 4L6 20',
  agents: 'M12 3a4 4 0 110 8 4 4 0 010-8zM4 21c0-4 3.6-6 8-6s8 2 8 6',
  capture: 'M4 6h16v12H4zM8 10l8 4-8 4z',
  usage: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  settings:
    'M12 8.5A3.5 3.5 0 1012 15.5 3.5 3.5 0 0012 8.5zM19 12l2-1.5-2-4-2.4.9a7.6 7.6 0 00-1.7-1L14.5 3h-5l-.4 2.4a7.6 7.6 0 00-1.7 1L5 5.5l-2 4L5 12l-2 1.5 2 4 2.4-.9c.5.4 1.1.8 1.7 1l.4 2.4h5l.4-2.4c.6-.2 1.2-.6 1.7-1l2.4.9 2-4z',
  diagnostics: 'M4 4h16v12H4zM8 20h8M12 16v4M8 8h8M8 12h5',
  check: 'M4 13l5 5L20 6',
  alert: 'M12 3l9 17H3zM12 9v5M12 17h.01',
  clock: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v5l3 2',
  dot: 'M12 9a3 3 0 100 6 3 3 0 000-6z',
  history: 'M4 12a8 8 0 108-8 8 8 0 00-6.9 4M4 4v5h5M12 8v4l3 2',
  'arrow-right': 'M4 12h14M12 5l7 7-7 7',
  cross: 'M6 6l12 12M18 6L6 18',
  trash: 'M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13',
  menu: 'M4 7h16M4 12h16M4 17h16',
  pause: 'M9 5v14M15 5v14',
  play: 'M7 4l12 8-12 8z',
  globe: 'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c3 3.5 3 14 0 18M12 3c-3 3.5-3 14 0 18',
  sun: 'M12 5V2M12 22v-3M5 12H2M22 12h-3M6.3 6.3L4.2 4.2M19.8 19.8l-2.1-2.1M17.7 6.3l2.1-2.1M4.2 19.8l2.1-2.1M12 8a4 4 0 100 8 4 4 0 000-8z',
  moon: 'M20 14a8 8 0 01-10-10 8 8 0 1010 10z',
  refresh: 'M20 12a8 8 0 11-2.3-5.7M20 4v5h-5',
  external: 'M14 4h6v6M20 4l-8 8M18 14v6H4V6h6',
  download: 'M12 4v10M8 10l4 4 4-4M4 19h16',
}

export function Icon({ name, size = 18, title }: { name: IconName; size?: number; title?: string }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <path d={ICON_PATHS[name]} />
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/* Cards and layout                                                    */
/* ------------------------------------------------------------------ */

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }): ReactNode {
  return (
    <div className="page-header">
      <div>
        <h1 className="page-header__title">{title}</h1>
        {subtitle ? <p className="page-header__sub">{subtitle}</p> : null}
      </div>
      {actions ? <div className="card__actions">{actions}</div> : null}
    </div>
  )
}

export function Card({
  title,
  actions,
  children,
  flush = false,
  id,
}: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  flush?: boolean
  id?: string
}): ReactNode {
  return (
    <section className="card" id={id}>
      {title !== undefined || actions !== undefined ? (
        <header className="card__header">
          <h2 className="card__title">{title}</h2>
          {actions ? <div className="card__actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className={flush ? 'card__body card__body--flush' : 'card__body'}>{children}</div>
    </section>
  )
}

export function Metric({ label, value }: { label: ReactNode; value: ReactNode }): ReactNode {
  return (
    <div className="metric">
      <span className="metric__label">{label}</span>
      <span className="metric__value">{value}</span>
    </div>
  )
}

export function KeyValue({ items }: { items: Array<{ key: string; label: string; value: ReactNode }> }): ReactNode {
  return (
    <dl className="kv">
      {items.map(item => (
        <div key={item.key} style={{ display: 'contents' }}>
          <dt className="kv__key">{item.label}</dt>
          <dd className="kv__value">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/* ------------------------------------------------------------------ */
/* Possibly-missing values                                             */
/* ------------------------------------------------------------------ */

/** Renders a Host value, or an explicit `unknown` marker when it is absent. */
export function MaybeValue({
  value,
  format,
}: {
  value: number | string | undefined | null
  format?: (value: number) => string
}): ReactNode {
  const { t } = useApp()
  if (value === undefined || value === null || value === '') {
    return <span className="muted">{t('common.unknown')}</span>
  }
  if (typeof value === 'number' && format) return <>{format(value)}</>
  return <>{value}</>
}

export function Unverifiable({ detail }: { detail?: string }): ReactNode {
  const { t } = useApp()
  return (
    <div className="state state--info">
      <p className="state__title">{t('evidence.unverifiable')}</p>
      <p className="state__body">{detail ?? t('evidence.unverifiableBody')}</p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Badges                                                              */
/* ------------------------------------------------------------------ */

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info'

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }): ReactNode {
  return (
    <span className={`badge badge--${tone}`} title={title}>
      {children}
    </span>
  )
}

const STATUS_TONE: Record<MemoryStatus, Tone> = {
  proposed: 'neutral',
  needs_review: 'warn',
  supported: 'info',
  verified: 'ok',
  conflicted: 'danger',
  stale: 'warn',
  superseded: 'neutral',
  rejected: 'danger',
  deleted: 'neutral',
}

const STATUS_ICON: Record<MemoryStatus, IconName> = {
  proposed: 'dot',
  needs_review: 'clock',
  supported: 'check',
  verified: 'check',
  conflicted: 'alert',
  stale: 'history',
  superseded: 'arrow-right',
  rejected: 'cross',
  deleted: 'trash',
}

/** Status badge: always text plus an icon, never colour alone. */
export function StatusBadge({ status }: { status: MemoryStatus }): ReactNode {
  const { t } = useApp()
  return (
    <Badge tone={STATUS_TONE[status] ?? 'neutral'}>
      <Icon name={STATUS_ICON[status] ?? 'dot'} size={13} />
      <span>{t(`status.${status}` as MessageKey)}</span>
    </Badge>
  )
}

const JOB_TONE: Record<string, Tone> = {
  received: 'neutral',
  redacted: 'info',
  admitted: 'info',
  extracting: 'info',
  validating: 'info',
  indexed: 'info',
  active: 'ok',
  retryable: 'warn',
  quarantined: 'danger',
  rejected: 'danger',
  cancelled: 'neutral',
}

export function JobStatusBadge({ status }: { status: JobStatus | string }): ReactNode {
  const { t } = useApp()
  const known = (Object.prototype.hasOwnProperty.call(JOB_TONE, status) ? status : undefined) as JobStatus | undefined
  return (
    <Badge tone={known ? JOB_TONE[known] ?? 'neutral' : 'neutral'}>
      <Icon name={known === 'quarantined' || known === 'rejected' ? 'alert' : 'dot'} size={13} />
      <span>{known ? t(`job.${known}` as MessageKey) : status}</span>
    </Badge>
  )
}

export type EnumGroup = 'scene' | 'kind' | 'scope' | 'action' | 'role' | 'trust' | 'evidenceType' | 'status' | 'job'

const ENUM_KNOWN: Record<EnumGroup, readonly string[]> = {
  scene: ['chat', 'working', 'coding'],
  kind: ['fact', 'preference', 'decision', 'experience', 'failure', 'todo', 'hypothesis'],
  scope: ['private', 'agent', 'workspace', 'project', 'shared'],
  action: ['read', 'propose', 'review', 'feedback', 'delete', 'admin'],
  role: ['owner', 'main', 'subagent', 'service'],
  trust: ['user_explicit', 'tool_observed', 'repository_observed', 'test_verified', 'external_cited', 'model_generated'],
  evidenceType: [
    'user_message',
    'assistant_message',
    'tool_result',
    'test_result',
    'git_commit',
    'git_diff',
    'file_content',
    'external_doc',
    'model_claim',
  ],
  status: ['proposed', 'needs_review', 'supported', 'verified', 'conflicted', 'stale', 'superseded', 'rejected', 'deleted'],
  job: [
    'received',
    'redacted',
    'admitted',
    'extracting',
    'validating',
    'indexed',
    'active',
    'retryable',
    'quarantined',
    'rejected',
    'cancelled',
  ],
}

/**
 * Badge for a Host enum value. Unknown values are rendered verbatim instead of
 * being forced through the dictionary (which would print a raw key).
 */
export function EnumBadge({ value, group, tone = 'neutral' }: { value: string; group: EnumGroup; tone?: Tone }): ReactNode {
  const { t } = useApp()
  const known = ENUM_KNOWN[group].includes(value)
  return <Badge tone={tone}>{known ? t(`${group}.${value}` as MessageKey) : value}</Badge>
}

/* ------------------------------------------------------------------ */
/* Async states                                                        */
/* ------------------------------------------------------------------ */

export function Skeleton({ rows = 4 }: { rows?: number }): ReactNode {
  const { t } = useApp()
  return (
    <div className="skeleton" role="status" aria-live="polite">
      <span className="sr-only">{t('state.loadingTitle')}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton__line" style={{ width: `${90 - index * 7}%` }} />
      ))}
    </div>
  )
}

export function EmptyState({ title, body, actions }: { title?: string; body?: string; actions?: ReactNode }): ReactNode {
  const { t } = useApp()
  return (
    <div className="state">
      <p className="state__title">{title ?? t('state.emptyTitle')}</p>
      <p className="state__body">{body ?? t('state.emptyBody')}</p>
      {actions ? <div className="state__actions">{actions}</div> : null}
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: ApiError; onRetry?: () => void }): ReactNode {
  const { t } = useApp()
  let title = t('state.errorTitle')
  let body: string = error.message || t('state.errorBody')
  let tone: 'error' | 'warn' | 'info' = 'error'

  if (error.forbidden) {
    title = t('state.forbiddenTitle')
    body = t('state.forbiddenBody')
    tone = 'warn'
  } else if (error.degraded) {
    title = t('state.degradedTitle')
    body = error.message || t('state.degradedBody')
    tone = 'warn'
  } else if (error.unauthorized) {
    title = t('state.unauthorizedTitle')
    body = t('state.unauthorizedBody')
    tone = 'warn'
  } else if (error.kind === 'timeout') {
    title = t('state.timeoutTitle')
    body = t('state.timeoutBody')
  } else if (error.kind === 'offline') {
    title = t('state.offlineTitle')
    body = t('state.offlineBody')
  } else if (error.conflict) {
    title = t('state.conflictTitle')
    body = t('state.conflictBody')
  }

  return (
    <div className={`state state--${tone}`} role="alert">
      <p className="state__title">{title}</p>
      <p className="state__body">
        {body}
        {error.code ? <span className="mono"> · {error.code}</span> : null}
      </p>
      <div className="state__actions">
        {onRetry && error.kind !== 'aborted' ? (
          <button type="button" className="btn" onClick={onRetry}>
            <Icon name="refresh" size={16} />
            {t('common.retry')}
          </button>
        ) : null}
      </div>
    </div>
  )
}

export interface AsyncViewProps<T> {
  resource: Resource<T>
  isEmpty?: (data: T) => boolean
  emptyTitle?: string
  emptyBody?: string
  emptyActions?: ReactNode
  skeletonRows?: number
  children: (data: T) => ReactNode
}

/**
 * Loading skeleton → explicit error/forbidden/degraded state → empty state →
 * content. Used by every page so all five request outcomes are handled.
 */
export function AsyncView<T>({
  resource,
  isEmpty,
  emptyTitle,
  emptyBody,
  emptyActions,
  skeletonRows = 4,
  children,
}: AsyncViewProps<T>): ReactNode {
  const { t } = useApp()
  if (resource.status === 'loading' && resource.data === undefined) return <Skeleton rows={skeletonRows} />
  if (resource.status === 'error' && resource.error && resource.data === undefined) {
    return <ErrorState error={resource.error} onRetry={resource.reload} />
  }
  if (resource.data === undefined) return <EmptyState title={t('state.emptyTitle')} body={t('state.emptyBody')} />
  if (isEmpty?.(resource.data)) {
    return <EmptyState title={emptyTitle} body={emptyBody} actions={emptyActions} />
  }
  return <>{children(resource.data)}</>
}

/** Inline error used inside an already-rendered section (e.g. a failed mutation). */
export function InlineError({ error, onDismiss }: { error: ApiError; onDismiss?: () => void }): ReactNode {
  const { t } = useApp()
  return (
    <div className="state state--error" role="alert">
      <p className="state__body wrap-anywhere">
        {error.message}
        {error.code ? <span className="mono"> · {error.code}</span> : null}
      </p>
      {onDismiss ? (
        <div className="state__actions">
          <button type="button" className="btn btn--sm" onClick={onDismiss}>
            {t('common.dismiss')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Form controls                                                       */
/* ------------------------------------------------------------------ */

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
}: {
  label: string
  htmlFor: string
  hint?: string
  error?: string
  required?: boolean
  children: ReactNode
}): ReactNode {
  const { t } = useApp()
  const describedBy = [error ? `${htmlFor}-error` : undefined, hint ? `${htmlFor}-hint` : undefined].filter(Boolean).join(' ')
  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
        {required ? <span className="sr-only"> ({t('common.required')})</span> : null}
      </label>
      <div>{children}</div>
      {hint ? (
        <p className="field__hint" id={`${htmlFor}-hint`} data-describedby={describedBy}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field__error" id={`${htmlFor}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function TextInput({
  id,
  value,
  onChange,
  placeholder,
  type = 'text',
  required,
  invalid,
  disabled,
  min,
  max,
  step,
  autoComplete,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: 'text' | 'search' | 'datetime-local' | 'number' | 'url'
  required?: boolean
  invalid?: boolean
  disabled?: boolean
  min?: number
  max?: number
  step?: number
  autoComplete?: string
}): ReactNode {
  return (
    <input
      id={id}
      className="input"
      type={type}
      value={value}
      placeholder={placeholder}
      required={required}
      aria-invalid={invalid ? true : undefined}
      aria-describedby={invalid ? `${id}-error` : undefined}
      disabled={disabled}
      autoComplete={autoComplete}
      min={min}
      max={max}
      step={step}
      onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
    />
  )
}

export function Textarea({
  id,
  value,
  onChange,
  placeholder,
  required,
  invalid,
  rows = 3,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  required?: boolean
  invalid?: boolean
  rows?: number
}): ReactNode {
  return (
    <textarea
      id={id}
      className="textarea"
      value={value}
      rows={rows}
      placeholder={placeholder}
      required={required}
      aria-invalid={invalid ? true : undefined}
      aria-describedby={invalid ? `${id}-error` : undefined}
      onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value)}
    />
  )
}

export interface SelectOption {
  value: string
  label: string
}

export function Select({
  id,
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
}: {
  id: string
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  ariaLabel?: string
}): ReactNode {
  return (
    <select
      id={id}
      className="select"
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value)}
    >
      {options.map(option => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

export function Checkbox({
  id,
  checked,
  onChange,
  label,
  disabled,
  hint,
}: {
  id: string
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
  hint?: string
}): ReactNode {
  return (
    <div className="stack-8">
      <label className="checkbox" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked)}
        />
        <span>{label}</span>
      </label>
      {hint ? (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/** Radio group with arrow-key support (roving tabindex). */
export function SegmentedControl({
  legend,
  value,
  options,
  onChange,
}: {
  legend: string
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
}): ReactNode {
  const name = useId()
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(event.key)) return
    event.preventDefault()
    const index = options.findIndex(option => option.value === value)
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1
    const next = options[(index + delta + options.length) % options.length]
    if (next) onChange(next.value)
  }
  return (
    <fieldset className="field" style={{ border: 'none', margin: 0, padding: 0 }}>
      <legend className="field__label">{legend}</legend>
      <div className="segmented" role="radiogroup" aria-label={legend} onKeyDown={onKeyDown}>
        {options.map(option => (
          <button
            key={option.value}
            type="button"
            role="radio"
            name={name}
            aria-checked={option.value === value}
            tabIndex={option.value === value ? 0 : -1}
            className="segmented__option"
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  )
}

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */

export interface Column<T> {
  key: string
  header: string
  render: (row: T) => ReactNode
  numeric?: boolean
  /** Hide this column on narrow screens (it is usually repeated elsewhere). */
  secondary?: boolean
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  selectable = false,
  selectedKey,
  onSelect,
}: {
  columns: Array<Column<T>>
  rows: T[]
  rowKey: (row: T) => string
  caption?: string
  selectable?: boolean
  selectedKey?: string
  onSelect?: (row: T) => void
}): ReactNode {
  return (
    <div className="table-wrap">
      <table className={`table ${selectable ? 'table--selectable' : ''}`}>
        {caption ? <caption>{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map(column => (
              <th key={column.key} scope="col">
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const key = rowKey(row)
            const selected = selectedKey === key
            return (
              <tr
                key={key}
                aria-selected={selectable ? selected : undefined}
                data-selected={selected ? 'true' : undefined}
                tabIndex={selectable ? 0 : undefined}
                onClick={selectable && onSelect ? () => onSelect(row) : undefined}
                onKeyDown={
                  selectable && onSelect
                    ? event => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          onSelect(row)
                        }
                      }
                    : undefined
                }
              >
                {columns.map(column => (
                  <td key={column.key} data-label={column.secondary ? '' : column.header} className={column.numeric ? 'text-right' : undefined}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number
  pageSize: number
  total: number | undefined
  onPage: (page: number) => void
}): ReactNode {
  const { t, locale } = useApp()
  const pages = total !== undefined && pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : undefined
  const from = total === undefined ? undefined : total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = total === undefined ? undefined : Math.min(page * pageSize, total)
  return (
    <div className="pagination">
      <button type="button" className="btn btn--sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        {t('common.previous')}
      </button>
      <span className="pagination__info">
        {pages !== undefined ? `${t('common.pageOf', { page, pages })} · ` : ''}
        {from !== undefined && to !== undefined ? t('common.showing', { from, to, total: total ?? 0 }) : `${formatNumber(total, locale)}`}
      </span>
      <button type="button" className="btn btn--sm" disabled={pages !== undefined ? page >= pages : false} onClick={() => onPage(page + 1)}>
        {t('common.next')}
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Dialog and drawer                                                   */
/* ------------------------------------------------------------------ */

export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}): ReactNode {
  const { t } = useApp()
  const panelRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => onClose(), [onClose])
  useFocusTrap(panelRef, true, close)
  const titleId = useId()

  return createPortal(
    <div className="modal">
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div className="modal__panel" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={panelRef}>
        <header className="modal__header">
          <h2 className="drawer__title" id={titleId}>
            {title}
          </h2>
        </header>
        <div className="modal__body">{children}</div>
        <footer className="modal__footer">
          {footer ?? (
            <button type="button" className="btn" onClick={onClose}>
              {t('common.close')}
            </button>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  )
}

export function Drawer({
  title,
  onClose,
  children,
  footer,
  side = 'right',
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  side?: 'right' | 'left'
}): ReactNode {
  const { t } = useApp()
  const panelRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => onClose(), [onClose])
  useFocusTrap(panelRef, true, close)
  const titleId = useId()

  return createPortal(
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside
        className={side === 'left' ? 'drawer drawer--nav' : 'drawer'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
      >
        <header className="drawer__header">
          <h2 className="drawer__title" id={titleId}>
            {title}
          </h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
            <Icon name="cross" />
          </button>
        </header>
        <div className="drawer__body">{children}</div>
        {footer ? <div className="drawer__footer">{footer}</div> : null}
      </aside>
    </>,
    document.body,
  )
}

/* ------------------------------------------------------------------ */
/* Charts (hand-rolled SVG)                                            */
/* ------------------------------------------------------------------ */

export interface Series {
  label: string
  color: string
  points: number[]
}

function pathFor(points: number[], width: number, height: number, max: number): string {
  if (points.length === 0) return ''
  const step = points.length > 1 ? width / (points.length - 1) : width
  return points
    .map((point, index) => {
      const x = index * step
      const y = height - (max > 0 ? (point / max) * height : 0)
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

export function Sparkline({
  points,
  width = 96,
  height = 28,
  color = 'var(--hy-accent)',
  ariaLabel,
}: {
  points: number[]
  width?: number
  height?: number
  color?: string
  ariaLabel: string
}): ReactNode {
  const max = points.length > 0 ? Math.max(...points) : 0
  return (
    <span className="sparkline">
      <svg
        className="chart__svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={ariaLabel}
      >
        {points.length > 1 ? (
          <path d={pathFor(points, width, height, max)} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" />
        ) : (
          <line x1={0} y1={height - 1} x2={width} y2={height - 1} stroke={color} strokeWidth={2} />
        )}
      </svg>
    </span>
  )
}

export function TrendChart({
  series,
  height = 120,
  ariaLabel,
  emptyLabel,
}: {
  series: Series[]
  height?: number
  ariaLabel: string
  emptyLabel: string
}): ReactNode {
  const width = 640
  const all = series.flatMap(item => item.points)
  const max = all.length > 0 ? Math.max(...all) : 0
  const hasData = all.length > 0

  if (!hasData) {
    return <p className="chart__empty">{emptyLabel}</p>
  }

  return (
    <div className="chart">
      <svg
        className="chart__svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={ariaLabel}
        preserveAspectRatio="none"
        style={{ height } as CSSProperties}
      >
        <line x1={0} y1={height - 1} x2={width} y2={height - 1} stroke="var(--hy-border)" strokeWidth={1} />
        {[0.25, 0.5, 0.75].map(ratio => (
          <line
            key={ratio}
            x1={0}
            y1={height * ratio}
            x2={width}
            y2={height * ratio}
            stroke="var(--hy-border)"
            strokeWidth={1}
            strokeDasharray="4 6"
          />
        ))}
        {series.map(item => (
          <path
            key={item.label}
            d={pathFor(item.points, width, height - 8, max)}
            fill="none"
            stroke={item.color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </svg>
      <div className="chart__legend">
        {series.map(item => (
          <span key={item.label} className="chart__legend-item">
            <span className="chart__swatch" style={{ background: item.color }} aria-hidden="true" />
            {item.label}
          </span>
        ))}
        <span className="chart__legend-item muted">max {max}</span>
      </div>
    </div>
  )
}

export function Meter({ ratio, label }: { ratio: number | undefined; label: string }): ReactNode {
  const { t, locale } = useApp()
  const clamped = ratio === undefined ? 0 : Math.max(0, Math.min(1, ratio > 1 ? ratio / 100 : ratio))
  return (
    <div className="stack-8">
      <div className="row-8">
        <span className="muted">{label}</span>
        <span className="sparkline__value">
          {ratio === undefined ? t('common.unknown') : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(clamped)}
        </span>
      </div>
      <div className="meter" role="img" aria-label={`${label}: ${ratio === undefined ? t('common.unknown') : clamped}`}>
        <div className="meter__bar" style={{ width: `${clamped * 100}%` }} />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Segmented nav for in-page sections                                  */
/* ------------------------------------------------------------------ */

export function TabList({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: string; label: string }>
  active: string
  onChange: (id: string) => void
}): ReactNode {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const index = tabs.findIndex(tab => tab.id === active)
    const next =
      event.key === 'Home'
        ? tabs[0]
        : event.key === 'End'
          ? tabs[tabs.length - 1]
          : tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]
    if (next) onChange(next.id)
  }
  return (
    <div className="tabs" role="tablist" onKeyDown={onKeyDown}>
      {tabs.map(tab => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`tab-${tab.id}`}
          aria-selected={tab.id === active}
          aria-controls={`panel-${tab.id}`}
          tabIndex={tab.id === active ? 0 : -1}
          className="tab"
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

export function useAnnounce(): (message: string) => void {
  const { announce } = useApp()
  return announce
}