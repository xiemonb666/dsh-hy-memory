/**
 * Settings: seven sections (Backend / Models / Recall / Capture / Security /
 * Storage / Advanced), loaded from `GET /api/settings` with its revision.
 *
 * Saves send only the changed top-level sections plus `expectedRevision`. A 409
 * opens a conflict dialog that shows both revisions side by side (my draft vs the
 * server copy) and offers to reload from the Host or to keep my values and retry
 * against the newer revision.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ApiError, api } from '../api'
import { formatDateTime, type MessageKey } from '../i18n'
import { useResource } from '../hooks'
import { useApp } from '../store'
import type { BackupResult, HealthResponse, PluginSettings, SettingsResponse } from '../types'
import {
  Card,
  Checkbox,
  ErrorState,
  Field,
  Icon,
  InlineError,
  KeyValue,
  Modal,
  PageHeader,
  Select,
  Skeleton,
  TextInput,
} from '../components/ui'

/* ------------------------------------------------------------------ */
/* Path helpers                                                        */
/* ------------------------------------------------------------------ */

type SettingsDraft = Record<string, unknown>

function getPath(source: unknown, path: string): unknown {
  let current: unknown = source
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function setPath<T extends Record<string, unknown>>(source: T, path: string, value: unknown): T {
  const segments = path.split('.')
  const clone: Record<string, unknown> = { ...source }
  let cursor: Record<string, unknown> = clone
  for (let index = 0; index < segments.length - 1; index++) {
    const key = segments[index] as string
    const next = cursor[key]
    const copy = next !== null && typeof next === 'object' && !Array.isArray(next) ? { ...(next as Record<string, unknown>) } : {}
    cursor[key] = copy
    cursor = copy
  }
  cursor[segments[segments.length - 1] as string] = value
  return clone as T
}

/* ------------------------------------------------------------------ */
/* Field descriptors                                                   */
/* ------------------------------------------------------------------ */

type FieldDef =
  | { kind: 'bool'; path: string; label: MessageKey; hint?: MessageKey; disabled?: boolean }
  | { kind: 'number'; path: string; label: MessageKey; min?: number; max?: number; step?: number; hint?: MessageKey }
  | { kind: 'text'; path: string; label: MessageKey; hint?: MessageKey; disabled?: boolean }
  | { kind: 'enum'; path: string; label: MessageKey; options: readonly string[]; hint?: MessageKey }

interface SectionDef {
  id: 'backend' | 'models' | 'recall' | 'capture' | 'security' | 'storage' | 'advanced'
  label: MessageKey
  fields: FieldDef[]
}

const SECTIONS: SectionDef[] = [
  {
    id: 'backend',
    label: 'settings.section.backend',
    fields: [
      { kind: 'bool', path: 'enabled', label: 'settings.backend.enabled' },
      { kind: 'enum', path: 'backend', label: 'settings.backend.backend', options: ['sdk'] },
      { kind: 'bool', path: 'safeMode', label: 'settings.backend.safeMode' },
      { kind: 'enum', path: 'profileScope', label: 'settings.backend.profileScope', options: ['current', 'isolated', 'all'] },
    ],
  },
  {
    id: 'models',
    label: 'settings.section.models',
    fields: [
      { kind: 'enum', path: 'models.mode', label: 'settings.models.mode', options: ['pro', 'ultra', 'lite'] },
      { kind: 'text', path: 'models.extractionEndpointEnv', label: 'settings.models.extractionEnv' },
      { kind: 'text', path: 'models.embeddingEndpointEnv', label: 'settings.models.embeddingEnv' },
      { kind: 'enum', path: 'models.externalEgress', label: 'settings.models.externalEgress', options: ['ask-first', 'deny', 'allow-configured'] },
      { kind: 'bool', path: 'models.localOnly', label: 'settings.models.localOnly' },
    ],
  },
  {
    id: 'recall',
    label: 'settings.section.recall',
    fields: [
      { kind: 'bool', path: 'recall.enabled', label: 'settings.recall.enabled' },
      { kind: 'enum', path: 'recall.mode', label: 'settings.recall.mode', options: ['clue-first', 'tool-only'] },
      { kind: 'enum', path: 'recall.trigger', label: 'settings.recall.trigger', options: ['task-boundary', 'every-step'] },
      { kind: 'number', path: 'recall.candidateLimit', label: 'settings.recall.candidateLimit', min: 1, max: 200 },
      { kind: 'number', path: 'recall.clueLimit', label: 'settings.recall.clueLimit', min: 0, max: 10 },
      { kind: 'number', path: 'recall.maxInjectionTokens', label: 'settings.recall.maxInjectionTokens', min: 0, max: 4000 },
      { kind: 'number', path: 'recall.maxSingleClueTokens', label: 'settings.recall.maxSingleClueTokens', min: 20, max: 1000 },
      { kind: 'number', path: 'recall.searchTimeoutMs', label: 'settings.recall.searchTimeoutMs', min: 50, max: 30000 },
      { kind: 'number', path: 'recall.cacheTtlSeconds', label: 'settings.recall.cacheTtlSeconds', min: 0, max: 3600 },
      { kind: 'bool', path: 'recall.allowUnverifiedAsFact', label: 'settings.recall.allowUnverifiedAsFact' },
      { kind: 'enum', path: 'recall.staleGuidance', label: 'settings.recall.staleGuidance', options: ['clue-only', 'hide'] },
      { kind: 'bool', path: 'recall.skipStaleTechFacts', label: 'settings.recall.skipStaleTechFacts' },
      { kind: 'enum', path: 'recall.fallback', label: 'settings.recall.fallback', options: ['no-memory'] },
    ],
  },
  {
    id: 'capture',
    label: 'settings.section.capture',
    fields: [
      { kind: 'bool', path: 'capture.enabled', label: 'settings.capture.enabled' },
      { kind: 'enum', path: 'capture.secretScrubbing', label: 'settings.capture.secretScrubbing', options: ['strict', 'off'] },
      { kind: 'number', path: 'capture.evidenceRetentionDays', label: 'settings.capture.retention', min: 1, max: 3650 },
      { kind: 'enum', path: 'capture.rawTracePolicy', label: 'settings.capture.rawTracePolicy', options: ['metadata-only', 'redacted-excerpt'] },
      { kind: 'number', path: 'capture.excludeToolOutputOverKb', label: 'settings.capture.excludeToolOutputOverKb', min: 1, max: 1024 },
      { kind: 'bool', path: 'capture.persistRawToolOutput', label: 'settings.capture.persistRawToolOutput' },
      { kind: 'number', path: 'capture.offlineQueueMaxMib', label: 'settings.capture.offlineQueueMaxMib', min: 1, max: 4096 },
      { kind: 'number', path: 'capture.maxWriteCostPerDayUsd', label: 'settings.capture.maxWriteCostPerDayUsd', min: 0, max: 1000, step: 0.1 },
      { kind: 'number', path: 'capture.maxBatchEvents', label: 'settings.capture.maxBatchEvents', min: 1, max: 500 },
    ],
  },
  {
    id: 'security',
    label: 'settings.section.security',
    fields: [
      { kind: 'bool', path: 'security.denyCrossProjectByDefault', label: 'settings.security.denyCrossProject' },
      { kind: 'enum', path: 'security.keyStorage', label: 'settings.security.keyStorage', options: ['os-keyring-or-0600-env'] },
      { kind: 'bool', path: 'security.auditLog', label: 'settings.security.auditLog' },
      { kind: 'bool', path: 'security.exportConfirmation', label: 'settings.security.exportConfirmation' },
      { kind: 'bool', path: 'security.autoPromoteModelClaims', label: 'settings.security.autoPromote', hint: 'settings.security.autoPromoteLocked', disabled: true },
    ],
  },
  {
    id: 'storage',
    label: 'settings.section.storage',
    fields: [
      { kind: 'number', path: 'capture.evidenceRetentionDays', label: 'settings.capture.retention', min: 1, max: 3650, hint: 'settings.storage.retentionHint' },
    ],
  },
  {
    id: 'advanced',
    label: 'settings.section.advanced',
    fields: [
      { kind: 'number', path: 'ui.port', label: 'settings.advanced.port', min: 1024, max: 65535 },
      { kind: 'enum', path: 'ui.locale', label: 'settings.advanced.locale', options: ['en', 'zh-CN'] },
      { kind: 'bool', path: 'ui.followHostTheme', label: 'settings.advanced.followHostTheme' },
      { kind: 'enum', path: 'agents.defaultScope', label: 'settings.advanced.agentsDefaultScope', options: ['private', 'agent', 'workspace', 'project', 'shared'] },
      { kind: 'number', path: 'agents.concurrency', label: 'settings.advanced.agentsConcurrency', min: 1, max: 16 },
    ],
  },
]

/* ------------------------------------------------------------------ */
/* Diff helpers                                                        */
/* ------------------------------------------------------------------ */

interface DiffEntry {
  path: string
  mine: unknown
  server: unknown
}

function collectDiff(mine: unknown, server: unknown, prefix = ''): DiffEntry[] {
  const entries: DiffEntry[] = []
  const mineRecord = mine !== null && typeof mine === 'object' ? (mine as Record<string, unknown>) : undefined
  const serverRecord = server !== null && typeof server === 'object' ? (server as Record<string, unknown>) : undefined
  if (!mineRecord || !serverRecord) {
    return [{ path: prefix, mine, server }]
  }
  const keys = new Set([...Object.keys(mineRecord), ...Object.keys(serverRecord)])
  for (const key of keys) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    const a = mineRecord[key]
    const b = serverRecord[key]
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      entries.push(...collectDiff(a, b, path))
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      entries.push({ path, mine: a, server: b })
    }
  }
  return entries
}

function changedSections(draft: SettingsDraft, server: SettingsDraft): SettingsDraft {
  const patch: SettingsDraft = {}
  for (const key of Object.keys(draft)) {
    if (JSON.stringify(draft[key]) !== JSON.stringify(server[key])) patch[key] = draft[key]
  }
  return patch
}

function displayValue(value: unknown): string {
  if (value === undefined) return '—'
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/* ------------------------------------------------------------------ */
/* Fields                                                              */
/* ------------------------------------------------------------------ */

function FieldRenderer({
  def,
  draft,
  onChange,
}: {
  def: FieldDef
  draft: SettingsDraft
  onChange: (path: string, value: unknown) => void
}): ReactNode {
  const { t } = useApp()
  const id = `setting-${def.path.replaceAll('.', '-')}`
  const raw = getPath(draft, def.path)
  const label = t(def.label)

  if (def.kind === 'bool') {
    return (
      <Checkbox
        id={id}
        checked={raw === true}
        disabled={def.disabled}
        onChange={value => onChange(def.path, value)}
        label={label}
        hint={def.hint ? t(def.hint) : undefined}
      />
    )
  }
  if (def.kind === 'number') {
    return (
      <Field label={label} htmlFor={id} hint={def.hint ? t(def.hint) : undefined}>
        <TextInput
          id={id}
          type="number"
          value={raw === undefined || raw === null ? '' : String(raw)}
          onChange={value => onChange(def.path, value === '' ? undefined : Number(value))}
          min={def.min}
          max={def.max}
          step={def.step}
        />
      </Field>
    )
  }
  if (def.kind === 'enum') {
    return (
      <Field label={label} htmlFor={id} hint={def.hint ? t(def.hint) : undefined}>
        <Select
          id={id}
          value={raw === undefined ? '' : String(raw)}
          onChange={value => onChange(def.path, value)}
          options={def.options.map(option => ({ value: option, label: option }))}
        />
      </Field>
    )
  }
  return (
    <Field label={label} htmlFor={id} hint={def.hint ? t(def.hint) : undefined}>
      <TextInput id={id} value={raw === undefined || raw === null ? '' : String(raw)} onChange={value => onChange(def.path, value)} disabled={def.disabled} />
    </Field>
  )
}

/* ------------------------------------------------------------------ */
/* Conflict dialog                                                     */
/* ------------------------------------------------------------------ */

function ConflictDialog({
  mine,
  server,
  baseRevision,
  onReload,
  onRetry,
}: {
  mine: SettingsDraft
  server: SettingsResponse
  baseRevision: number | undefined
  onReload: () => void
  onRetry: () => void
}): ReactNode {
  const { t } = useApp()
  const serverSettings = (server.settings ?? {}) as unknown as SettingsDraft
  const entries = useMemo(() => collectDiff(mine, serverSettings), [mine, serverSettings])
  return (
    <Modal
      title={t('settings.conflictTitle')}
      onClose={onReload}
      footer={
        <>
          <button type="button" className="btn" onClick={onReload}>
            {t('settings.reload')}
          </button>
          <button type="button" className="btn btn--primary" onClick={onRetry}>
            {t('settings.reapply')}
          </button>
        </>
      }
    >
      <p>{t('settings.conflictBody')}</p>
      <div className="row-8">
        <span className="badge badge--neutral">
          {t('settings.yourRevision')}: {baseRevision === undefined ? t('settings.revisionUnreported') : baseRevision}
        </span>
        <span className="badge badge--warn">
          {t('settings.serverRevision')}: {server.revision}
        </span>
      </div>
      {entries.length === 0 ? (
        <p className="muted">{t('common.noData')}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t('common.name')}</th>
                <th scope="col">{t('settings.yourValue')}</th>
                <th scope="col">{t('settings.serverValue')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(entry => (
                <tr key={entry.path}>
                  <td data-label={t('common.name')} className="mono wrap-anywhere">
                    {entry.path}
                  </td>
                  <td data-label={t('settings.yourValue')} className="wrap-anywhere">
                    {displayValue(entry.mine)}
                  </td>
                  <td data-label={t('settings.serverValue')} className="wrap-anywhere">
                    {displayValue(entry.server)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

function TestConnection(): ReactNode {
  const { t, locale } = useApp()
  const [pending, setPending] = useState(false)
  const [health, setHealth] = useState<HealthResponse | undefined>(undefined)
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [checkedAt, setCheckedAt] = useState<string | undefined>(undefined)

  const run = async () => {
    setPending(true)
    setError(undefined)
    try {
      const response = await api.health()
      setHealth(response)
      setCheckedAt(new Date().toISOString())
    } catch (caught) {
      setHealth(undefined)
      setError(caught instanceof ApiError ? caught : new ApiError({ message: String(caught), kind: 'offline' }))
    } finally {
      setPending(false)
    }
  }

  return (
    <Card title={t('settings.testConnection')}>
      <div className="section-stack">
        <div className="row-8">
          <button type="button" className="btn" onClick={() => void run()} disabled={pending}>
            <Icon name="refresh" size={15} /> {pending ? t('common.loading') : t('settings.testConnection')}
          </button>
          {health ? (
            <span className={`badge ${health.ok && !health.degraded ? 'badge--ok' : 'badge--warn'}`}>
              {health.ok && !health.degraded ? t('settings.testOk') : t('settings.testFail')}
            </span>
          ) : null}
          {checkedAt ? <span className="muted">{formatDateTime(checkedAt, locale)}</span> : null}
        </div>
        {health ? (
          <KeyValue
            items={[
              { key: 'plugin', label: t('diagnostics.versions'), value: health.plugin?.version ?? t('common.unknown') },
              { key: 'engine', label: t('diagnostics.engine'), value: health.worker?.engine ?? t('common.unknown') },
              { key: 'engineVersion', label: t('diagnostics.engineVersion'), value: health.worker?.engineVersion ?? t('common.unknown') },
              {
                key: 'queue',
                label: t('diagnostics.queueDepth'),
                value: health.worker?.queueDepth === undefined ? t('common.unknown') : String(health.worker.queueDepth),
              },
              { key: 'reason', label: t('common.reason'), value: health.reason ?? health.worker?.reason ?? t('common.none') },
            ]}
          />
        ) : null}
        {error ? <InlineError error={error} onDismiss={() => setError(undefined)} /> : null}
      </div>
    </Card>
  )
}

function StorageSection({ settings, dataDir }: { settings: SettingsResponse; dataDir: string }): ReactNode {
  const { t, projectId, announce, capabilities } = useApp()
  const [backup, setBackup] = useState<BackupResult | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | undefined>(undefined)

  const runBackup = async () => {
    setPending(true)
    setError(undefined)
    try {
      const result = await api.backup()
      setBackup(result)
      announce(t('settings.storage.backupDone', { path: result.path }))
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError({ message: String(caught), kind: 'offline' }))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="section-stack">
      <KeyValue items={[{ key: 'dataDir', label: t('settings.storage.dataDir'), value: <span className="mono wrap-anywhere">{dataDir || t('common.unknown')}</span> }]} />
      <div className="row-8">
        <button type="button" className="btn" onClick={() => void runBackup()} disabled={pending || capabilities.canBackup === false}>
          <Icon name="check" size={15} /> {pending ? t('common.loading') : t('settings.storage.backupRun')}
        </button>
        {capabilities.canExport === false ? null : (
          <a className="btn" href={api.exportUrl(projectId || undefined, true)}>
            <Icon name="external" size={15} /> {t('settings.storage.export')}
          </a>
        )}
      </div>
      <p className="field__hint">{t('settings.storage.exportHint')}</p>
      {backup ? (
        <div className="preview-box">
          <span className="mono wrap-anywhere">{backup.path}</span>
          <span className="mono">sha256 {backup.sha256}</span>
        </div>
      ) : null}
      {error ? <InlineError error={error} onDismiss={() => setError(undefined)} /> : null}
      <p className="muted">{t('settings.revision', { revision: settings.revision })}</p>
    </div>
  )
}

export function SettingsPage(): ReactNode {
  const { t, announce } = useApp()
  const resource = useResource<SettingsResponse>(signal => api.settings(signal), [])
  const [draft, setDraft] = useState<SettingsDraft | undefined>(undefined)
  const [baseRevision, setBaseRevision] = useState<number | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [conflict, setConflict] = useState<{ mine: SettingsDraft; server: SettingsResponse } | undefined>(undefined)
  const [activeSection, setActiveSection] = useState<SectionDef['id']>('backend')

  useEffect(() => {
    if (!resource.data) return
    setDraft(resource.data.settings as unknown as SettingsDraft)
    setBaseRevision(resource.data.revision)
  }, [resource.data])

  const serverSettings = (resource.data?.settings ?? {}) as unknown as SettingsDraft
  const patch = draft ? changedSections(draft, serverSettings) : {}
  const dirty = Object.keys(patch).length > 0

  const update = (path: string, value: unknown) => {
    setDraft(previous => (previous ? setPath(previous, path, value) : previous))
  }

  const save = async (revision: number | undefined, values: SettingsDraft | undefined, base: SettingsDraft = serverSettings) => {
    if (!values || revision === undefined) return
    setPending(true)
    setError(undefined)
    try {
      const saved = await api.saveSettings({ patch: changedSections(values, base), expectedRevision: revision })
      announce(t('settings.saved', { revision: saved.revision }))
      setDraft(saved.settings as unknown as SettingsDraft)
      setBaseRevision(saved.revision)
      setConflict(undefined)
      resource.setData(saved)
    } catch (caught) {
      const failure = caught instanceof ApiError ? caught : new ApiError({ message: String(caught), kind: 'offline' })
      if (failure.conflict) {
        try {
          const latest = await api.settings()
          setConflict({ mine: values, server: latest })
        } catch {
          setConflict({ mine: values, server: resource.data ?? { settings: {} as PluginSettings, revision: revision } })
        }
      } else {
        setError(failure)
      }
    } finally {
      setPending(false)
    }
  }

  if (resource.status === 'loading' && !resource.data) {
    return (
      <>
        <PageHeader title={t('settings.title')} subtitle={t('settings.subtitle')} />
        <Skeleton rows={8} />
      </>
    )
  }

  if (resource.status === 'error' && !resource.data) {
    return (
      <>
        <PageHeader title={t('settings.title')} subtitle={t('settings.subtitle')} />
        <ErrorState error={resource.error ?? new ApiError({ message: t('settings.loadFailed'), kind: 'offline' })} onRetry={resource.reload} />
      </>
    )
  }

  const dataDir = (resource.data?.settings?.dataDir ?? '') as string
  const section: SectionDef = SECTIONS.find(item => item.id === activeSection) ?? (SECTIONS[0] as SectionDef)

  return (
    <>
      <PageHeader
        title={t('settings.title')}
        subtitle={t('settings.subtitle')}
        actions={
          <div className="row-8">
            {dirty ? <span className="badge badge--warn">{t('settings.unsaved')}</span> : null}
            <button type="button" className="btn btn--primary" onClick={() => void save(baseRevision, draft)} disabled={pending || !dirty}>
              <Icon name="check" size={15} /> {pending ? t('common.saving') : t('settings.save')}
            </button>
          </div>
        }
      />

      {resource.data ? <p className="muted">{t('settings.revision', { revision: resource.data.revision })}</p> : null}

      <div className="tabs" role="tablist" aria-label={t('settings.title')}>
        {SECTIONS.map(item => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`settings-tab-${item.id}`}
            aria-selected={item.id === activeSection}
            aria-controls={`settings-panel-${item.id}`}
            className="tab"
            onClick={() => setActiveSection(item.id)}
          >
            {t(item.label)}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`settings-panel-${activeSection}`} aria-labelledby={`settings-tab-${activeSection}`}>
        <Card title={t(section.label)}>
          {draft ? (
            <div className="grid grid--2">
              {section.fields.map(def => (
                <FieldRenderer key={`${section.id}-${def.path}`} def={def} draft={draft} onChange={update} />
              ))}
            </div>
          ) : (
            <Skeleton rows={4} />
          )}
        </Card>
      </div>

      {activeSection === 'storage' ? <StorageSection settings={resource.data ?? { settings: {} as PluginSettings, revision: 0 }} dataDir={dataDir} /> : null}

      {activeSection === 'advanced' && draft ? (
        <Card title={t('settings.section.advanced')}>
          <KeyValue
            items={[
              {
                key: 'token',
                label: t('settings.advanced.tokenConfigured'),
                value: getPath(draft, 'ui.token') ? t('common.yes') : t('common.no'),
              },
              { key: 'merge', label: t('settings.advanced.mergePolicy'), value: String(getPath(draft, 'agents.mergePolicy') ?? t('common.unknown')) },
              { key: 'shared', label: t('settings.advanced.sharedMemory'), value: String(getPath(draft, 'agents.sharedMemory') ?? t('common.unknown')) },
              { key: 'version', label: t('settings.advanced.version'), value: String(getPath(draft, 'version') ?? t('common.unknown')) },
            ]}
          />
        </Card>
      ) : null}

      <div className="grid grid--2">
        <TestConnection />
        <Card title={t('common.details')}>
          <KeyValue
            items={[
              { key: 'enabled', label: t('settings.backend.enabled'), value: getPath(serverSettings, 'enabled') ? t('common.yes') : t('common.no') },
              { key: 'backend', label: t('settings.backend.backend'), value: String(getPath(serverSettings, 'backend') ?? t('common.unknown')) },
              { key: 'revision', label: t('common.revision'), value: String(baseRevision ?? t('common.unknown')) },
            ]}
          />
          <div className="row-8" style={{ marginTop: 8 }}>
            <span className="tag">{String(getPath(serverSettings, 'profileScope') ?? t('common.unknown'))}</span>
          </div>
        </Card>
      </div>

      {error ? <ErrorState error={error} onRetry={() => void save(baseRevision, draft)} /> : null}

      {conflict ? (
        <ConflictDialog
          mine={conflict.mine}
          server={conflict.server}
          baseRevision={baseRevision}
          onReload={() => {
            setConflict(undefined)
            resource.reload()
          }}
          onRetry={() => {
            setConflict(undefined)
            void save(conflict.server.revision, conflict.mine)
          }}
        />
      ) : null}
    </>
  )
}

export default SettingsPage
