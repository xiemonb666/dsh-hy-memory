/**
 * Evidence & Versions: commit timeline, diff viewer (line numbers, collapsible
 * hunks, patch hash), test-results table, code freshness and the memory state
 * with its revert badges.
 *
 * Sections whose source data is absent render an explicit `Unverifiable` state —
 * the page never guesses a commit, exit code or environment.
 */
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../api'
import { formatDateTime, formatNumber } from '../i18n'
import { hrefFor, navigate, useDebouncedValue, useResource } from '../hooks'
import { useApp } from '../store'
import { parsePatch, countLines, type DiffHunk } from '../patch'
import type { CodeResponse, MemoryDetail, MemorySummary, PatchFile, TestResult } from '../types'
import {
  AsyncView,
  Card,
  DataTable,
  EnumBadge,
  Field,
  Icon,
  KeyValue,
  MaybeValue,
  PageHeader,
  Skeleton,
  StatusBadge,
  TextInput,
  Unverifiable,
  type Column,
} from '../components/ui'

/* ------------------------------------------------------------------ */
/* Diff viewer                                                         */
/* ------------------------------------------------------------------ */

function HunkView({ hunk, index }: { hunk: DiffHunk; index: number }): ReactNode {
  const { t } = useApp()
  const [collapsed, setCollapsed] = useState(index > 0)
  const label = hunk.header || `${t('evidence.diffHunk')} ${index + 1}`
  return (
    <div className="diff__hunk">
      <div className="diff__hunk-header">
        <span>{label}</span>
        <span className="row-8">
          <span className="muted">{t('evidence.diffLines', { count: hunk.lines.length })}</span>
          <button
            type="button"
            className="btn btn--sm"
            aria-expanded={!collapsed}
            onClick={() => setCollapsed(value => !value)}
          >
            {collapsed ? t('evidence.diffExpand') : t('evidence.diffCollapse')}
          </button>
        </span>
      </div>
      {collapsed ? null : (
        <ul className="diff__lines">
          {hunk.lines.map((line, lineIndex) => (
            <li key={`${index}-${lineIndex}`} className={`diff__line diff__line--${line.kind}`}>
              <span className="diff__gutter">{line.oldLine ?? ''}</span>
              <span className="diff__gutter">{line.newLine ?? ''}</span>
              <span aria-hidden="true">{line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}</span>
              <span>{line.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function PatchView({ file }: { file: PatchFile }): ReactNode {
  const { t } = useApp()
  const hunks = useMemo(() => parsePatch(file.patch), [file.patch])
  if (hunks.length === 0) return <Unverifiable detail={t('evidence.diffEmpty')} />
  return (
    <div className="diff">
      {file.path ? <div className="diff__file mono wrap-anywhere">{file.path}</div> : null}
      {hunks.map((hunk, index) => (
        <HunkView key={`${hunk.header}-${index}`} hunk={hunk} index={index} />
      ))}
      <p className="field__hint" style={{ padding: '0 8px 8px' }}>
        {t('evidence.diffLines', { count: countLines(hunks) })}
      </p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

function CommitTimeline({ code }: { code: CodeResponse }): ReactNode {
  const { t, locale } = useApp()
  const entries = code.bindings
  if (entries.length === 0) {
    return <Unverifiable detail={t('evidence.timelineEmpty')} />
  }
  return (
    <ol className="timeline">
      {entries.map(binding => (
        <li className="timeline__item" key={binding.id}>
          <span className="timeline__marker" aria-hidden="true" />
          <div className="timeline__body">
            <div className="row-8">
              <span className="mono">{binding.headCommit?.slice(0, 12) ?? t('common.unknown')}</span>
              {binding.baseCommit ? <span className="tag">← {binding.baseCommit.slice(0, 12)}</span> : null}
              {binding.branch ? <span className="tag">{binding.branch}</span> : null}
              {binding.patchHash ? <span className="tag mono">patch {binding.patchHash.slice(0, 12)}</span> : null}
            </div>
            <p className="timeline__meta">
              {binding.filePath ?? binding.id}
              {binding.symbol ? ` · ${binding.symbol}` : ''} · {formatDateTime(binding.createdAt, locale)}
            </p>
          </div>
        </li>
      ))}
    </ol>
  )
}

function TestTable({ tests }: { tests: TestResult[] }): ReactNode {
  const { t } = useApp()
  if (tests.length === 0) return <Unverifiable detail={t('evidence.testsEmpty')} />
  const columns: Array<Column<TestResult>> = [
    {
      key: 'suite',
      header: t('common.name'),
      render: test => <span className="wrap-anywhere">{test.suite ?? test.command ?? test.id ?? t('common.unknown')}</span>,
    },
    {
      key: 'commit',
      header: t('evidence.testsCommit'),
      render: test => <span className="mono">{test.commit?.slice(0, 12) ?? t('common.unknown')}</span>,
    },
    {
      key: 'exit',
      header: t('evidence.testsExitCode'),
      numeric: true,
      render: test => (test.exitCode === undefined ? <span className="muted">{t('common.unknown')}</span> : <span className="mono">{test.exitCode}</span>),
    },
    {
      key: 'environment',
      header: t('evidence.testsEnvironment'),
      render: test => <MaybeValue value={test.environment} />,
    },
    {
      key: 'result',
      header: t('evidence.testsResult'),
      render: test =>
        test.passed === undefined ? (
          <span className="badge badge--neutral">{t('common.unknown')}</span>
        ) : test.passed ? (
          <span className="badge badge--ok">
            <Icon name="check" size={13} /> {t('evidence.testsPass')}
          </span>
        ) : (
          <span className="badge badge--danger">
            <Icon name="cross" size={13} /> {t('evidence.testsFail')}
          </span>
        ),
    },
  ]
  return <DataTable columns={columns} rows={tests} rowKey={test => test.id ?? `${test.commit}-${test.exitCode}-${test.suite}`} />
}

function MemoryState({ detail }: { detail: MemoryDetail }): ReactNode {
  const { t, locale } = useApp()
  const memory = detail.memory
  const reverted = detail.versions.filter(version => version.revertedFrom !== undefined && version.revertedFrom !== null)
  return (
    <div className="section-stack">
      <div className="row-8">
        <StatusBadge status={memory.status} />
        <EnumBadge group="scope" value={memory.scope} />
        {reverted.length > 0 ? (
          <span className="badge badge--warn">
            <Icon name="history" size={13} /> {t('evidence.revertBadge')}
          </span>
        ) : null}
      </div>
      <KeyValue
        items={[
          { key: 'id', label: t('common.id'), value: <span className="mono wrap-anywhere">{memory.id}</span> },
          { key: 'revision', label: t('common.revision'), value: String(memory.revision) },
          { key: 'version', label: t('common.version'), value: memory.version === undefined ? t('common.unknown') : String(memory.version) },
          { key: 'updated', label: t('common.updated'), value: formatDateTime(memory.updatedAt, locale) },
          {
            key: 'evidence',
            label: t('common.evidenceCount'),
            value: memory.evidenceCount === undefined ? t('common.unknown') : formatNumber(memory.evidenceCount, locale),
          },
        ]}
      />
    </div>
  )
}

function Freshness({ code }: { code: CodeResponse }): ReactNode {
  const { t, locale } = useApp()
  if (!code.freshness) return <Unverifiable detail={t('evidence.unverifiableBody')} />
  const fresh = code.freshness
  const state = fresh.stale === undefined ? t('evidence.freshnessUnknown') : fresh.stale ? t('evidence.freshnessStale') : t('evidence.freshnessFresh')
  return (
    <KeyValue
      items={[
        {
          key: 'state',
          label: t('evidence.freshness'),
          value: (
            <span className={`badge ${fresh.stale === undefined ? 'badge--neutral' : fresh.stale ? 'badge--warn' : 'badge--ok'}`}>{state}</span>
          ),
        },
        { key: 'head', label: t('evidence.headCommit'), value: <span className="mono">{fresh.headCommit?.slice(0, 12) ?? t('common.unknown')}</span> },
        { key: 'base', label: t('evidence.baseCommit'), value: <span className="mono">{fresh.baseCommit?.slice(0, 12) ?? t('common.unknown')}</span> },
        { key: 'checked', label: t('evidence.testsRanAt'), value: formatDateTime(fresh.checkedAt, locale) },
        { key: 'reason', label: t('common.reason'), value: <MaybeValue value={fresh.reason} /> },
      ]}
    />
  )
}

/* ------------------------------------------------------------------ */
/* Picker (no memory selected)                                         */
/* ------------------------------------------------------------------ */

function MemoryPicker(): ReactNode {
  const { t, locale, projectId, workspaceId } = useApp()
  const [query, setQuery] = useState('')
  const debounced = useDebouncedValue(query, 300)
  const resource = useResource(
    signal =>
      api.memories(
        { projectId: projectId || undefined, workspaceId: workspaceId || undefined, q: debounced || undefined, page: 1, pageSize: 25 },
        signal,
      ),
    [projectId, workspaceId, debounced],
  )

  const columns: Array<Column<MemorySummary>> = [
    { key: 'title', header: t('memories.row.title'), render: memory => <span className="wrap-anywhere">{memory.title}</span> },
    { key: 'status', header: t('common.status'), render: memory => <StatusBadge status={memory.status} /> },
    {
      key: 'updated',
      header: t('memories.row.updated'),
      render: memory => formatDateTime(memory.updatedAt, locale),
    },
    {
      key: 'open',
      header: t('common.actions'),
      render: memory => (
        <button type="button" className="btn btn--sm" onClick={() => navigate('evidence', { memoryId: memory.id })}>
          {t('common.open')}
        </button>
      ),
    },
  ]

  return (
    <Card title={t('evidence.noMemorySelected')}>
      <div className="section-stack">
        <p className="muted">{t('evidence.noMemorySelectedBody')}</p>
        <Field label={t('memories.searchLabel')} htmlFor="evidence-picker-search">
          <TextInput id="evidence-picker-search" type="search" value={query} onChange={setQuery} placeholder={t('memories.searchPlaceholder')} />
        </Field>
        <AsyncView resource={resource} isEmpty={page => page.items.length === 0} skeletonRows={4}>
          {page => <DataTable columns={columns} rows={page.items} rowKey={memory => memory.id} />}
        </AsyncView>
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export function EvidencePage({ params }: { params: URLSearchParams }): ReactNode {
  const memoryId = params.get('memoryId') ?? ''
  return memoryId ? <EvidenceDetail memoryId={memoryId} /> : <EvidencePickerPage />
}

function EvidencePickerPage(): ReactNode {
  const { t } = useApp()
  return (
    <>
      <PageHeader title={t('evidence.title')} subtitle={t('evidence.subtitle')} />
      <MemoryPicker />
    </>
  )
}

function EvidenceDetail({ memoryId }: { memoryId: string }): ReactNode {
  const { t } = useApp()
  const detail = useResource<MemoryDetail>(signal => api.memory(memoryId, signal), [memoryId])
  const code = useResource<CodeResponse>(signal => api.code(memoryId, signal), [memoryId])

  return (
    <>
      <PageHeader
        title={t('evidence.title')}
        subtitle={t('evidence.subtitle')}
        actions={
          <a className="btn btn--sm" href={hrefFor('memories')}>
            {t('memories.title')}
          </a>
        }
      />

      <div className="grid grid--2">
        <Card title={t('evidence.memoryState')}>
          <AsyncView resource={detail} skeletonRows={4}>
            {data => <MemoryState detail={data} />}
          </AsyncView>
        </Card>
        <Card title={t('evidence.freshness')}>
          {code.status === 'loading' && !code.data ? <Skeleton rows={3} /> : null}
          {code.error && !code.data ? <Unverifiable detail={code.error.message} /> : null}
          {code.data ? <Freshness code={code.data} /> : null}
        </Card>
      </div>

      <Card title={t('evidence.timeline')}>
        {code.status === 'loading' && !code.data ? <Skeleton rows={4} /> : null}
        {code.error && !code.data ? (
          <Unverifiable detail={`${t('evidence.unverifiableBody')} (${code.error.message})`} />
        ) : null}
        {code.data ? <CommitTimeline code={code.data} /> : null}
      </Card>

      <Card title={t('evidence.diff')}>
        {code.status === 'loading' && !code.data ? <Skeleton rows={6} /> : null}
        {code.error && !code.data ? <Unverifiable detail={code.error.message} /> : null}
        {code.data ? (
          code.data.diffs.length === 0 ? (
            <Unverifiable detail={t('evidence.diffEmpty')} />
          ) : (
            <div className="section-stack">
              {code.data.diffs.map((file, index) => (
                <PatchView key={`${file.path}-${index}`} file={file} />
              ))}
            </div>
          )
        ) : null}
      </Card>

      <Card title={t('evidence.bindings')} flush>
        {code.data ? (
          code.data.bindings.length === 0 ? (
            <div style={{ padding: 16 }}>
              <Unverifiable detail={t('evidence.bindingsEmpty')} />
            </div>
          ) : (
            <DataTable
              columns={[
                { key: 'file', header: t('evidence.file'), render: binding => <span className="mono wrap-anywhere">{binding.filePath ?? t('common.unknown')}</span> },
                { key: 'symbol', header: t('evidence.symbol'), render: binding => <MaybeValue value={binding.symbol} /> },
                { key: 'branch', header: t('evidence.branch'), render: binding => <MaybeValue value={binding.branch} /> },
                {
                  key: 'head',
                  header: t('evidence.headCommit'),
                  render: binding => <span className="mono">{binding.headCommit?.slice(0, 12) ?? t('common.unknown')}</span>,
                },
                {
                  key: 'patch',
                  header: t('evidence.patchHash'),
                  render: binding => <span className="mono">{binding.patchHash?.slice(0, 16) ?? t('common.unknown')}</span>,
                },
              ]}
              rows={code.data.bindings}
              rowKey={binding => binding.id}
            />
          )
        ) : null}
      </Card>

      <Card title={t('evidence.tests')} flush>
        {code.data ? <TestTable tests={code.data.tests} /> : null}
      </Card>

      <Card title={t('evidence.validations')}>
        <AsyncView resource={detail} skeletonRows={3}>
          {data =>
            data.validations.length === 0 ? (
              <p className="muted">{t('evidence.validationsEmpty')}</p>
            ) : (
              <ul className="inline-list">
                {data.validations.map((validation, index) => (
                  <li className="inline-list__item" key={validation.id ?? index}>
                    <span className="row-8">
                      <span className="tag">{validation.kind ?? t('common.unknown')}</span>
                      {validation.passed === undefined ? (
                        <span className="badge badge--neutral">{t('common.unknown')}</span>
                      ) : validation.passed ? (
                        <span className="badge badge--ok">{t('evidence.validationPass')}</span>
                      ) : (
                        <span className="badge badge--danger">{t('evidence.validationFail')}</span>
                      )}
                    </span>
                    {validation.detail ? <span className="wrap-anywhere">{validation.detail}</span> : null}
                  </li>
                ))}
              </ul>
            )
          }
        </AsyncView>
      </Card>
    </>
  )
}

export default EvidencePage