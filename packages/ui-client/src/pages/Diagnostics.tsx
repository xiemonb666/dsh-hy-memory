/**
 * Diagnostics: DSH/profile/plugin/worker versions, dependency checks, data
 * paths, audit-chain status, the log download link, the permission matrix and
 * recent redacted audit events.
 */
import type { ReactNode } from 'react'
import { api, apiUrl } from '../api'
import { formatDateTime } from '../i18n'
import { useResource } from '../hooks'
import { useApp } from '../store'
import type { AuditEvent, DiagnosticsResponse } from '../types'
import {
  AsyncView,
  Card,
  DataTable,
  Icon,
  KeyValue,
  MaybeValue,
  PageHeader,
  Unverifiable,
  type Column,
} from '../components/ui'

function VersionGrid({ data }: { data: DiagnosticsResponse }): ReactNode {
  const { t } = useApp()
  const entries: Array<{ key: string; label: string; value: string | undefined }> = [
    { key: 'dsh', label: 'DSH', value: data.versions.dsh },
    { key: 'profile', label: t('diagnostics.profile'), value: data.versions.profile ?? data.profileName },
    { key: 'plugin', label: 'Plugin', value: data.versions.plugin },
    { key: 'worker', label: 'Worker', value: data.versions.worker },
    { key: 'ui', label: 'Studio UI', value: data.versions.ui },
    { key: 'node', label: 'Node', value: data.versions.node },
    { key: 'python', label: 'Python', value: data.versions.python },
  ]
  return (
    <KeyValue
      items={entries.map(entry => ({
        key: entry.key,
        label: entry.label,
        value: entry.value ? <span className="mono">{entry.value}</span> : <MaybeValue value={undefined} />,
      }))}
    />
  )
}

function DependencyTable({ data }: { data: DiagnosticsResponse }): ReactNode {
  const { t } = useApp()
  if (data.dependencies.length === 0) return <Unverifiable detail={t('diagnostics.dependenciesEmpty')} />
  const columns: Array<Column<DiagnosticsResponse['dependencies'][number]>> = [
    { key: 'name', header: t('common.name'), render: row => <span className="mono wrap-anywhere">{row.name}</span> },
    {
      key: 'status',
      header: t('common.status'),
      render: row =>
        row.ok ? (
          <span className="badge badge--ok">
            <Icon name="check" size={13} /> {t('diagnostics.depOk')}
          </span>
        ) : (
          <span className="badge badge--danger">
            <Icon name="cross" size={13} /> {t('diagnostics.depFail')}
          </span>
        ),
    },
    { key: 'version', header: t('common.version'), render: row => <MaybeValue value={row.version} /> },
    { key: 'detail', header: t('common.details'), render: row => <MaybeValue value={row.detail} /> },
  ]
  return <DataTable columns={columns} rows={data.dependencies} rowKey={row => row.name} />
}

function AuditBlock({ data }: { data: DiagnosticsResponse }): ReactNode {
  const { t, locale } = useApp()
  const audit = data.audit
  if (audit.ok === undefined && audit.headHash === undefined) {
    return <Unverifiable detail={t('diagnostics.auditUnknown')} />
  }
  return (
    <div className="section-stack">
      <div className="row-8">
        {audit.ok === undefined ? (
          <span className="badge badge--neutral">{t('diagnostics.auditUnknown')}</span>
        ) : audit.ok ? (
          <span className="badge badge--ok">
            <Icon name="check" size={13} /> {t('diagnostics.auditOk')}
          </span>
        ) : (
          <span className="badge badge--danger">
            <Icon name="alert" size={13} /> {t('diagnostics.auditBroken')}
          </span>
        )}
      </div>
      <KeyValue
        items={[
          { key: 'length', label: t('diagnostics.auditLength'), value: audit.length === undefined ? t('common.unknown') : String(audit.length) },
          { key: 'head', label: t('diagnostics.auditHead'), value: <span className="mono wrap-anywhere">{audit.headHash ?? t('common.unknown')}</span> },
          { key: 'verified', label: t('diagnostics.auditVerifiedAt'), value: formatDateTime(audit.verifiedAt, locale) },
          { key: 'broken', label: t('diagnostics.auditBrokenAt'), value: audit.brokenAt ? formatDateTime(audit.brokenAt, locale) : t('common.none') },
        ]}
      />
    </div>
  )
}

function PathsBlock({ data }: { data: DiagnosticsResponse }): ReactNode {
  const { t } = useApp()
  const entries = [
    { key: 'dataDir', label: t('settings.storage.dataDir'), value: data.paths.dataDir },
    { key: 'db', label: 'SQLite', value: data.paths.db },
    { key: 'logs', label: t('diagnostics.logs'), value: data.paths.logs },
    { key: 'artifacts', label: 'Artifacts', value: data.paths.artifacts },
    { key: 'backup', label: t('settings.storage.backup'), value: data.paths.backup },
  ].filter(entry => entry.value !== undefined)

  if (entries.length === 0) return <Unverifiable detail={t('common.noData')} />

  return (
    <div className="section-stack">
      {entries.map(entry => (
        <div className="row-8" key={entry.key}>
          <span className="muted">{entry.label}</span>
          <span className="mono wrap-anywhere">{entry.value}</span>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              void navigator.clipboard?.writeText(entry.value ?? '')
            }}
          >
            {t('diagnostics.copyPath')}
          </button>
        </div>
      ))}
    </div>
  )
}

function PermissionMatrix({ data }: { data: DiagnosticsResponse }): ReactNode {
  const { t } = useApp()
  const rows = data.permissionMatrix ?? []
  if (rows.length === 0) return <Unverifiable detail={t('diagnostics.permissionMatrixEmpty')} />
  return (
    <div className="table-wrap">
      <table className="matrix">
        <caption className="sr-only">{t('diagnostics.permissionMatrix')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('diagnostics.roles')}</th>
            <th scope="col">{t('common.scope')}</th>
            <th scope="col">{t('diagnostics.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.role}>
              <th scope="row">{row.role}</th>
              <td>{row.scopes.join(', ') || t('common.none')}</td>
              <td>{row.actions.join(', ') || t('common.none')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function EventsTable(): ReactNode {
  const { t, locale } = useApp()
  const resource = useResource<AuditEvent[]>(signal => api.events(50, signal), [])

  const columns: Array<Column<AuditEvent>> = [
    { key: 'at', header: t('common.created'), render: row => formatDateTime(row.at, locale) },
    { key: 'action', header: t('common.type'), render: row => <span className="mono">{row.action}</span> },
    { key: 'actor', header: t('common.role'), render: row => <MaybeValue value={row.actor} /> },
    { key: 'object', header: t('common.id'), render: row => <span className="mono wrap-anywhere">{row.objectId ?? row.objectType ?? '—'}</span> },
    { key: 'outcome', header: t('common.status'), render: row => <MaybeValue value={row.outcome} /> },
  ]

  return (
    <AsyncView resource={resource} isEmpty={events => events.length === 0} emptyTitle={t('diagnostics.eventsEmpty')} skeletonRows={4}>
      {events => <DataTable columns={columns} rows={events} rowKey={event => event.id} />}
    </AsyncView>
  )
}

export function DiagnosticsPage(): ReactNode {
  const { t, capabilities, health } = useApp()
  const resource = useResource<DiagnosticsResponse>(signal => api.diagnostics(signal), [])
  const logUrl = resource.data?.logDownloadUrl ?? capabilities.logDownloadUrl

  return (
    <>
      <PageHeader title={t('diagnostics.title')} subtitle={t('diagnostics.subtitle')} />

      <AsyncView resource={resource} skeletonRows={6}>
        {data => (
          <>
            <div className="grid grid--2">
              <Card title={t('diagnostics.versions')}>
                <VersionGrid data={data} />
              </Card>
              <Card title={t('diagnostics.worker')}>
                {data.worker ? (
                  <KeyValue
                    items={[
                      { key: 'engine', label: t('diagnostics.engine'), value: data.worker.engine ?? t('common.unknown') },
                      { key: 'version', label: t('diagnostics.engineVersion'), value: data.worker.engineVersion ?? t('common.unknown') },
                      {
                        key: 'degraded',
                        label: t('header.healthDegraded'),
                        value: data.worker.degraded === undefined ? t('common.unknown') : data.worker.degraded ? t('common.yes') : t('common.no'),
                      },
                      {
                        key: 'queue',
                        label: t('diagnostics.queueDepth'),
                        value: data.worker.queueDepth === undefined ? t('common.unknown') : String(data.worker.queueDepth),
                      },
                      { key: 'reason', label: t('common.reason'), value: data.worker.reason ?? t('common.none') },
                    ]}
                  />
                ) : (
                  <Unverifiable detail={health ? t('common.noData') : t('state.offlineBody')} />
                )}
              </Card>
            </div>

            <Card title={t('diagnostics.dependencies')} flush>
              <DependencyTable data={data} />
            </Card>

            <div className="grid grid--2">
              <Card title={t('diagnostics.dataPaths')}>
                <PathsBlock data={data} />
              </Card>
              <Card title={t('diagnostics.auditChain')}>
                <AuditBlock data={data} />
              </Card>
            </div>

            <Card title={t('diagnostics.logs')}>
              {logUrl ? (
                <a className="btn" href={logUrl.startsWith('http') ? logUrl : apiUrl(logUrl)}>
                  <Icon name="download" size={15} /> {t('diagnostics.downloadLogs')}
                </a>
              ) : (
                <p className="muted">{t('diagnostics.noLogLink')}</p>
              )}
            </Card>

            <Card title={t('diagnostics.permissionMatrix')}>
              <PermissionMatrix data={data} />
            </Card>
          </>
        )}
      </AsyncView>

      <Card title={t('diagnostics.events')} flush>
        <EventsTable />
      </Card>
    </>
  )
}

export default DiagnosticsPage