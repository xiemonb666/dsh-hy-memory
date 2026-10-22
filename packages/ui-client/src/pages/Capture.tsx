/**
 * Capture & Queue: the capture toggles (saved through the revisioned settings
 * endpoint), the historical-import warning, the queue board
 * (queued/running/retrying/quarantined/done) with retry and cancel, and the
 * redaction report — counts only, never captured content.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ApiError, api } from '../api'
import { formatDateTime, formatNumber } from '../i18n'
import { useResource } from '../hooks'
import { useApp } from '../store'
import type { CaptureJob, CaptureSettings, JobQueueColumn, SettingsResponse } from '../types'
import {
  AsyncView,
  Card,
  Checkbox,
  ErrorState,
  Field,
  Icon,
  InlineError,
  JobStatusBadge,
  Metric,
  PageHeader,
  Skeleton,
  TextInput,
} from '../components/ui'

/** Queue column membership, derived from the contract's job status vocabulary. */
const COLUMN_STATUSES: Record<JobQueueColumn, readonly string[]> = {
  queued: ['received', 'redacted', 'admitted'],
  running: ['extracting', 'validating', 'indexed', 'active'],
  retrying: ['retryable'],
  quarantined: ['quarantined', 'rejected'],
  done: ['cancelled'],
}

function columnOf(status: string): JobQueueColumn | undefined {
  for (const column of Object.keys(COLUMN_STATUSES) as JobQueueColumn[]) {
    if (COLUMN_STATUSES[column].includes(status)) return column
  }
  return undefined
}

interface ToggleState {
  enabled: boolean
  enableChat: boolean
  enableWorking: boolean
  enableCoding: boolean
  autoCapture: boolean
  historicalImport: boolean
}

function toToggleState(capture: CaptureSettings | undefined): ToggleState | undefined {
  if (!capture) return undefined
  return {
    enabled: capture.enabled,
    enableChat: capture.enableChat,
    enableWorking: capture.enableWorking,
    enableCoding: capture.enableCoding,
    autoCapture: capture.autoCapture,
    historicalImport: capture.historicalImport,
  }
}

function CaptureToggles({ settings, onSaved }: { settings: SettingsResponse; onSaved: () => void }): ReactNode {
  const { t, announce } = useApp()
  const [state, setState] = useState<ToggleState | undefined>(() => toToggleState(settings.settings?.capture))
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [confirmImport, setConfirmImport] = useState(false)

  useEffect(() => {
    setState(toToggleState(settings.settings?.capture))
  }, [settings])

  if (!state) {
    return (
      <Card title={t('capture.toggles')}>
        <p className="muted">{t('settings.unsupportedSection')}</p>
      </Card>
    )
  }

  const set = <K extends keyof ToggleState>(key: K, value: ToggleState[K]) => setState(previous => (previous ? { ...previous, [key]: value } : previous))

  const save = async () => {
    if (state.historicalImport && !confirmImport) {
      setConfirmImport(true)
      return
    }
    setPending(true)
    setError(undefined)
    try {
      await api.saveSettings({ patch: { capture: state }, expectedRevision: settings.revision })
      announce(t('capture.saved'))
      setConfirmImport(false)
      onSaved()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError({ message: String(caught), kind: 'offline' }))
    } finally {
      setPending(false)
    }
  }

  return (
    <Card title={t('capture.toggles')}>
      <div className="section-stack">
        <div className="grid grid--2">
          <Checkbox id="capture-enabled" checked={state.enabled} onChange={value => set('enabled', value)} label={t('capture.enabled')} />
          <Checkbox id="capture-chat" checked={state.enableChat} onChange={value => set('enableChat', value)} label={t('capture.chat')} />
          <Checkbox id="capture-working" checked={state.enableWorking} onChange={value => set('enableWorking', value)} label={t('capture.working')} />
          <Checkbox id="capture-coding" checked={state.enableCoding} onChange={value => set('enableCoding', value)} label={t('capture.coding')} />
          <Checkbox id="capture-auto" checked={state.autoCapture} onChange={value => set('autoCapture', value)} label={t('capture.autoCapture')} />
          <Checkbox id="capture-historical" checked={state.historicalImport} onChange={value => set('historicalImport', value)} label={t('capture.historicalImport')} />
        </div>

        {state.historicalImport ? (
          <div className="state state--warn" role="alert">
            <p className="state__title">
              <Icon name="alert" size={16} /> {t('capture.historicalImport')}
            </p>
            <p className="state__body">{t('capture.historicalWarning')}</p>
            {confirmImport ? <Checkbox id="historical-ack" checked={confirmImport} onChange={setConfirmImport} label={t('memories.delete.acknowledge')} /> : null}
          </div>
        ) : null}

        <div className="row-8">
          <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={pending || (state.historicalImport && !confirmImport)}>
            <Icon name="check" size={15} /> {pending ? t('common.saving') : t('capture.saveToggles')}
          </button>
        </div>

        {error ? <ErrorState error={error} onRetry={() => void save()} /> : null}
      </div>
    </Card>
  )
}

function JobCard({ job, onChanged }: { job: CaptureJob; onChanged: () => void }): ReactNode {
  const { t, locale, capabilities, announce } = useApp()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const cancellable = capabilities.canCancelJobs === true

  const retry = async () => {
    setPending(true)
    setError(undefined)
    try {
      await api.retryJob(job.id)
      announce(t('capture.retried'))
      onChanged()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError({ message: String(caught), kind: 'offline' }))
    } finally {
      setPending(false)
    }
  }

  const cancel = async () => {
    if (!cancellable) {
      setError(new ApiError({ message: t('capture.cancelUnsupported'), kind: 'http', status: 400 }))
      return
    }
    setPending(true)
    setError(undefined)
    try {
      await api.cancelJob(job.id)
      announce(t('capture.cancelled'))
      onChanged()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError({ message: String(caught), kind: 'offline' }))
    } finally {
      setPending(false)
    }
  }

  return (
    <li className="queue__item">
      <span className="mono wrap-anywhere">{job.id}</span>
      <JobStatusBadge status={job.status} />
      <span className="muted">
        {t('capture.attempts')}: {job.attempt ?? t('common.unknown')}
        {job.nextRetryAt ? ` · ${t('capture.nextRetry')}: ${formatDateTime(job.nextRetryAt, locale)}` : ''}
      </span>
      {job.errorCode ? <span className="mono">{t('capture.errorCode')}: {job.errorCode}</span> : null}
      <span className="queue__item-actions">
        <button type="button" className="btn btn--sm" onClick={() => void retry()} disabled={pending}>
          {t('capture.retry')}
        </button>
        <button type="button" className="btn btn--sm" onClick={() => void cancel()} disabled={pending || !cancellable} title={cancellable ? undefined : t('capture.cancelUnsupported')}>
          {t('capture.cancel')}
        </button>
      </span>
      {error ? <InlineError error={error} onDismiss={() => setError(undefined)} /> : null}
    </li>
  )
}

function QueueBoard({ jobs, onChanged }: { jobs: CaptureJob[]; onChanged: () => void }): ReactNode {
  const { t } = useApp()
  const columns: JobQueueColumn[] = ['queued', 'running', 'retrying', 'quarantined', 'done']
  return (
    <div className="queue">
      {columns.map(column => {
        const items = jobs.filter(job => columnOf(job.status) === column)
        return (
          <section className="queue__column" key={column} aria-label={t(`capture.queue.${column}`)}>
            <header className="queue__column-header">
              <span>{t(`capture.queue.${column}`)}</span>
              <span className="badge badge--neutral">{items.length}</span>
            </header>
            {items.length === 0 ? (
              <p className="muted" style={{ padding: 8 }}>
                {t('capture.emptyBody')}
              </p>
            ) : (
              <ul className="queue__list">
                {items.map(job => (
                  <JobCard key={job.id} job={job} onChanged={onChanged} />
                ))}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}

/**
 * The contract has no dedicated redaction endpoint; counts are read from the
 * diagnostics payload when the Host includes them and reported as unavailable
 * otherwise.
 */
function RedactionReport(): ReactNode {
  const { t, locale } = useApp()
  const resource = useResource(signal => api.diagnostics(signal), [])
  const counts = (resource.data as { redaction?: { secrets?: number; events?: number; skipped?: number } } | undefined)?.redaction
  return (
    <Card title={t('capture.redaction')}>
      <div className="section-stack">
        <p className="muted">{t('capture.redactionBody')}</p>
        {resource.status === 'loading' && !resource.data ? <Skeleton rows={3} /> : null}
        {counts ? (
          <div className="stack-8">
            <Metric label={t('capture.redactionSecrets')} value={formatNumber(counts.secrets, locale)} />
            <Metric label={t('capture.redactionEvents')} value={formatNumber(counts.events, locale)} />
            <Metric label={t('capture.redactionSkipped')} value={formatNumber(counts.skipped, locale)} />
          </div>
        ) : (
          <p className="muted">{t('capture.redactionUnavailable')}</p>
        )}
      </div>
    </Card>
  )
}

export function CapturePage(): ReactNode {
  const { t, locale } = useApp()
  const settings = useResource<SettingsResponse>(signal => api.settings(signal), [])
  const jobs = useResource(signal => api.jobs({}, signal), [])
  const [statusFilter, setStatusFilter] = useState('')

  return (
    <>
      <PageHeader title={t('capture.title')} subtitle={t('capture.subtitle')} />

      {settings.status === 'loading' && !settings.data ? <Skeleton rows={5} /> : null}
      {settings.error && !settings.data ? <ErrorState error={settings.error} onRetry={settings.reload} /> : null}
      {settings.data ? <CaptureToggles settings={settings.data} onSaved={settings.reload} /> : null}

      <Card
        title={t('capture.queue')}
        actions={
          <div className="row-8">
            <Field label={t('common.status')} htmlFor="job-status-filter">
              <TextInput id="job-status-filter" value={statusFilter} onChange={setStatusFilter} placeholder={t('common.all')} />
            </Field>
            <button type="button" className="btn btn--sm" onClick={jobs.reload}>
              <Icon name="refresh" size={15} /> {t('common.refresh')}
            </button>
          </div>
        }
      >
        <AsyncView resource={jobs} isEmpty={page => page.items.length === 0} emptyTitle={t('capture.empty')} emptyBody={t('capture.emptyBody')} skeletonRows={6}>
          {page => {
            const filtered = statusFilter
              ? page.items.filter(job => job.status.toLowerCase().includes(statusFilter.toLowerCase()))
              : page.items
            return (
              <div className="section-stack">
                <p className="muted">{t('common.rows', { count: formatNumber(filtered.length, locale) })}</p>
                <QueueBoard jobs={filtered} onChanged={jobs.reload} />
              </div>
            )
          }}
        </AsyncView>
      </Card>

      <RedactionReport />
    </>
  )
}

export default CapturePage