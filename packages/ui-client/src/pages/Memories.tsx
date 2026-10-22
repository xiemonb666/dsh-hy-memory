/**
 * Memory Explorer: search + filters + paged list, and a detail drawer with the
 * full record, claims, qualifiers, evidence, version timeline, code bindings and
 * the injection-token cost preview.
 *
 * Mutations (`transition`, `feedback`) go through the Host state machine with the
 * record revision, so a concurrent edit surfaces as an explicit revision conflict.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ApiError, api } from '../api'
import { formatDateTime, formatNumber, formatRelative, type MessageKey } from '../i18n'
import { useDebouncedValue, useResource, type Resource } from '../hooks'
import { useApp } from '../store'
import { estimateMemoryTokens } from '../tokens'
import {
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  SCENES,
  SEARCH_MODES,
  type MemoryDetail,
  type MemoryQuery,
  type MemoryStatus,
  type MemorySummary,
} from '../types'
import {
  AsyncView,
  Card,
  Checkbox,
  DataTable,
  Drawer,
  EnumBadge,
  ErrorState,
  Field,
  Icon,
  InlineError,
  MaybeValue,
  Modal,
  PageHeader,
  Pagination,
  SegmentedControl,
  Select,
  Skeleton,
  StatusBadge,
  TextInput,
  Textarea,
  type Column,
} from '../components/ui'

const PAGE_SIZES = [10, 20, 50]

interface Filters {
  q: string
  mode: (typeof SEARCH_MODES)[number]
  scene: string
  status: string
  kind: string
  scope: string
  agentId: string
  pageSize: number
}

function labelOptions(values: readonly string[], group: string, t: (key: MessageKey) => string): Array<{ value: string; label: string }> {
  return [
    { value: '', label: t('common.all') },
    ...values.map(value => ({ value, label: t(`${group}.${value}` as MessageKey) })),
  ]
}

/* ------------------------------------------------------------------ */
/* Detail drawer                                                       */
/* ------------------------------------------------------------------ */

function ClaimList({ detail }: { detail: MemoryDetail }): ReactNode {
  const { t } = useApp()
  if (detail.claims.length === 0) return <p className="muted">{t('memories.detail.noClaims')}</p>
  return (
    <ul className="inline-list">
      {detail.claims.map((claim, index) => (
        <li className="inline-list__item" key={claim.id ?? `${claim.subject}-${index}`}>
          <span className="claim-triple">
            {claim.subject} · {claim.predicate} · {claim.object}
          </span>
          <span className="row-8">
            {claim.polarity ? <span className="tag">{t(`polarity.${claim.polarity}` as MessageKey)}</span> : null}
            {claim.validFrom ? <span className="tag">from {claim.validFrom}</span> : null}
            {claim.validUntil ? <span className="tag">until {claim.validUntil}</span> : null}
          </span>
          <span>
            <strong>{t('memories.detail.qualifiers')}: </strong>
            {claim.qualifiers && Object.keys(claim.qualifiers).length > 0 ? (
              <span className="row-8">
                {Object.entries(claim.qualifiers).map(([key, value]) => (
                  <span className="tag" key={key}>
                    {key}={value}
                  </span>
                ))}
              </span>
            ) : (
              <span className="muted">{t('common.none')}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

function EvidenceList({ detail }: { detail: MemoryDetail }): ReactNode {
  const { t, locale } = useApp()
  if (detail.evidence.length === 0) return <p className="muted">{t('memories.detail.noEvidence')}</p>
  return (
    <ul className="inline-list">
      {detail.evidence.map(item => (
        <li className="inline-list__item" key={item.id}>
          <span className="row-8">
            <EnumBadge group="evidenceType" value={item.type} />
            <EnumBadge group="trust" value={item.trustLevel} />
            <span className="muted mono">{item.sha256.slice(0, 12)}</span>
          </span>
          <span className="muted">
            {t('common.created')}: {formatDateTime(item.createdAt, locale)}
            {item.uri ? ` · ${item.uri}` : ''}
          </span>
          {item.excerpt ? <span className="wrap-anywhere">{item.excerpt}</span> : null}
        </li>
      ))}
    </ul>
  )
}

function VersionTimeline({ detail }: { detail: MemoryDetail }): ReactNode {
  const { t, locale } = useApp()
  if (detail.versions.length === 0) return <p className="muted">{t('memories.detail.noVersions')}</p>
  return (
    <ol className="timeline">
      {detail.versions.map(version => (
        <li className="timeline__item" key={`${version.version}-${version.createdAt}`}>
          <span className="timeline__marker" aria-hidden="true" />
          <div className="timeline__body">
            <div className="row-8">
              <strong>v{version.version}</strong>
              {version.status ? <StatusBadge status={version.status} /> : null}
              {version.revertedFrom !== undefined && version.revertedFrom !== null ? (
                <span className="badge badge--warn">
                  <Icon name="history" size={13} /> {t('memories.detail.revertBadge')} ← v{version.revertedFrom}
                </span>
              ) : null}
            </div>
            <p className="timeline__meta">
              {formatDateTime(version.createdAt, locale)}
              {version.authorPrincipalId ? ` · ${version.authorPrincipalId}` : ''}
              {version.revision !== undefined ? ` · r${version.revision}` : ''}
            </p>
            {version.note ? <p>{version.note}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  )
}

function BindingList({ detail }: { detail: MemoryDetail }): ReactNode {
  const { t } = useApp()
  if (detail.bindings.length === 0) return <p className="muted">{t('memories.detail.noBindings')}</p>
  return (
    <ul className="inline-list">
      {detail.bindings.map(binding => (
        <li className="inline-list__item" key={binding.id}>
          <span className="mono wrap-anywhere">{binding.filePath ?? binding.id}</span>
          <span className="muted">
            {binding.symbol ? `${binding.symbol} · ` : ''}
            {binding.branch ?? '—'} · {binding.headCommit?.slice(0, 10) ?? '—'}
          </span>
          {binding.patchHash ? <span className="muted mono">patch {binding.patchHash.slice(0, 16)}</span> : null}
        </li>
      ))}
    </ul>
  )
}

interface TransitionRequest {
  to: MemoryStatus
  title: string
  from: MemoryStatus
}

function TransitionModal({
  request,
  memoryId,
  revision,
  onClose,
  onDone,
}: {
  request: TransitionRequest
  memoryId: string
  revision: number
  onClose: () => void
  onDone: () => void
}): ReactNode {
  const { t } = useApp()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const [needsReload, setNeedsReload] = useState(false)

  const submit = async () => {
    if (reason.trim() === '') {
      setError(new ApiError({ message: t('common.reasonRequired'), kind: 'http', status: 400 }))
      return
    }
    setPending(true)
    setError(undefined)
    try {
      await api.transitionMemory(memoryId, { to: request.to, reason: reason.trim(), expectedRevision: revision })
      onDone()
      onClose()
    } catch (caught) {
      const failure = caught instanceof ApiError ? caught : new ApiError({ message: String(caught), kind: 'offline' })
      if (failure.conflict) setNeedsReload(true)
      setError(failure)
    } finally {
      setPending(false)
    }
  }

  return (
    <Modal
      title={t('memories.action.transitionTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void submit()} disabled={pending || needsReload}>
            {pending ? t('common.saving') : t('common.confirm')}
          </button>
        </>
      }
    >
      <p>{t('memories.action.transitionBody', { title: request.title, from: t(`status.${request.from}` as MessageKey), to: t(`status.${request.to}` as MessageKey) })}</p>
      <Field label={t('memories.action.transitionReason')} htmlFor="transition-reason" required>
        <Textarea
          id="transition-reason"
          value={reason}
          onChange={setReason}
          placeholder={t('memories.action.transitionReasonPlaceholder')}
          required
          invalid={reason.trim() === '' && error !== undefined}
        />
      </Field>
      {error ? <ErrorState error={error} onRetry={needsReload ? onDone : undefined} /> : null}
    </Modal>
  )
}

interface DeleteRequest {
  title: string
  from: MemoryStatus
  affected: number | undefined
}

function DeleteModal({
  request,
  memoryId,
  revision,
  onClose,
  onDone,
}: {
  request: DeleteRequest
  memoryId: string
  revision: number
  onClose: () => void
  onDone: () => void
}): ReactNode {
  const { t } = useApp()
  const [acknowledged, setAcknowledged] = useState(false)
  const [confirmedOnce, setConfirmedOnce] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [pending, setPending] = useState(false)

  const submit = async () => {
    if (!acknowledged || !confirmedOnce) {
      setError(new ApiError({ message: t('memories.delete.needAck'), kind: 'http', status: 400 }))
      return
    }
    if (reason.trim() === '') {
      setError(new ApiError({ message: t('common.reasonRequired'), kind: 'http', status: 400 }))
      return
    }
    setPending(true)
    setError(undefined)
    try {
      await api.transitionMemory(memoryId, { to: 'deleted', reason: reason.trim(), expectedRevision: revision })
      onDone()
      onClose()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError({ message: String(caught), kind: 'offline' }))
    } finally {
      setPending(false)
    }
  }

  return (
    <Modal
      title={t('memories.delete.title')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => {
              // Two explicit steps: arm the deletion, then commit it.
              if (!confirmedOnce) {
                setConfirmedOnce(true)
                return
              }
              void submit()
            }}
            disabled={pending || !acknowledged}
          >
            {pending ? t('common.saving') : confirmedOnce ? t('memories.delete.confirm') : t('memories.delete.arm')}
          </button>
        </>
      }
    >
      <p>{t('memories.delete.body')}</p>
      <p className="mono wrap-anywhere">{request.title}</p>
      <p>
        {request.affected === undefined
          ? t('memories.delete.affectedUnknown')
          : t('memories.delete.affected', { count: request.affected })}
      </p>
      <Field label={t('memories.action.transitionReason')} htmlFor="delete-reason" required>
        <Textarea id="delete-reason" value={reason} onChange={setReason} required invalid={reason.trim() === '' && error !== undefined} />
      </Field>
      <Checkbox id="delete-ack" checked={acknowledged} onChange={setAcknowledged} label={t('memories.delete.acknowledge')} />
      {confirmedOnce ? (
        <p className="state state--error" role="alert">
          <span className="state__title">{t('memories.delete.finalWarning')}</span>
        </p>
      ) : null}
      {error ? <InlineError error={error} onDismiss={() => setError(undefined)} /> : null}
    </Modal>
  )
}

function DetailDrawer({ memoryId, onClose, onChanged }: { memoryId: string; onClose: () => void; onChanged: () => void }): ReactNode {
  const { t, locale, announce } = useApp()
  const resource: Resource<MemoryDetail> = useResource<MemoryDetail>(signal => api.memory(memoryId, signal), [memoryId])
  const [transition, setTransition] = useState<TransitionRequest | undefined>(undefined)
  const [deleting, setDeleting] = useState<DeleteRequest | undefined>(undefined)
  const [feedbackPending, setFeedbackPending] = useState(false)
  const [feedbackError, setFeedbackError] = useState<ApiError | undefined>(undefined)

  const detail = resource.data
  const memory = detail?.memory

  const tokenCost = useMemo(() => {
    if (!detail || !memory) return undefined
    const claimTexts = detail.claims.map(claim => `${claim.subject} ${claim.predicate} ${claim.object}`)
    return estimateMemoryTokens(memory.content, claimTexts)
  }, [detail, memory])

  const sendFeedback = async (kind: 'useful' | 'incorrect' | 'stale') => {
    setFeedbackPending(true)
    setFeedbackError(undefined)
    try {
      await api.feedbackMemory(memoryId, { kind })
      announce(t('memories.feedbackDone'))
    } catch (caught) {
      setFeedbackError(caught instanceof ApiError ? caught : new ApiError({ message: String(caught), kind: 'offline' }))
    } finally {
      setFeedbackPending(false)
    }
  }

  return (
    <Drawer title={t('memories.detailTitle')} onClose={onClose}>
      {resource.status === 'loading' && !detail ? <Skeleton rows={6} /> : null}
      {resource.error && !detail ? <ErrorState error={resource.error} onRetry={resource.reload} /> : null}
      {detail && memory ? (
        <>
          <div className="section-stack">
            <div className="row-8">
              <StatusBadge status={memory.status} />
              <EnumBadge group="scope" value={memory.scope} />
              {memory.scene ? <EnumBadge group="scene" value={memory.scene} /> : null}
              {memory.kind ? <EnumBadge group="kind" value={memory.kind} /> : null}
              {memory.sensitivity ? <span className="tag">{memory.sensitivity}</span> : null}
            </div>
            <h3 className="wrap-anywhere" style={{ margin: 0 }}>
              {memory.title}
            </h3>
            <p className="muted mono wrap-anywhere">{memory.id}</p>
            <p className="muted">
              {t('common.updated')}: {formatDateTime(memory.updatedAt, locale)} · {t('common.revision')} {memory.revision}
              {memory.version !== undefined ? ` · ${t('common.version')} ${memory.version}` : ''}
            </p>
          </div>

          <Card title={t('memories.detail.content')}>
            <p className="wrap-anywhere" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
              {memory.content === '' ? t('common.noData') : memory.content}
            </p>
          </Card>

          <Card title={t('memories.detail.tokenCost')}>
            <div className="token-cost">
              <span className="token-cost__value">
                {tokenCost === undefined ? t('common.unknown') : formatNumber(tokenCost, locale)}
              </span>
              <p className="field__hint">{t('memories.detail.tokenCostHint')}</p>
            </div>
          </Card>

          <Card title={t('memories.detail.claims')}>
            <ClaimList detail={detail} />
          </Card>

          <Card title={t('memories.detail.evidence')}>
            <EvidenceList detail={detail} />
          </Card>

          <Card title={t('memories.detail.versions')}>
            <VersionTimeline detail={detail} />
          </Card>

          <Card title={t('memories.detail.bindings')}>
            <BindingList detail={detail} />
          </Card>

          <Card title={t('evidence.validations')}>
            {detail.validations.length === 0 ? (
              <p className="muted">{t('evidence.validationsEmpty')}</p>
            ) : (
              <ul className="inline-list">
                {detail.validations.map((validation, index) => (
                  <li className="inline-list__item" key={validation.id ?? index}>
                    <span className="row-8">
                      <span className="tag">{validation.kind ?? '—'}</span>
                      {validation.passed === undefined ? (
                        <span className="badge badge--neutral">{t('common.unknown')}</span>
                      ) : validation.passed ? (
                        <span className="badge badge--ok">{t('evidence.validationPass')}</span>
                      ) : (
                        <span className="badge badge--danger">{t('evidence.validationFail')}</span>
                      )}
                    </span>
                    {validation.detail ? <span className="muted wrap-anywhere">{validation.detail}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={t('memories.detail.actions')}>
            <div className="stack-8">
              <div className="row-8">
                {memory.status !== 'stale' ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setTransition({ to: 'stale', from: memory.status, title: memory.title })}
                  >
                    <Icon name="history" size={15} /> {t('memories.action.markStale')}
                  </button>
                ) : null}
                {memory.status !== 'needs_review' ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setTransition({ to: 'needs_review', from: memory.status, title: memory.title })}
                  >
                    <Icon name="clock" size={15} /> {t('memories.action.requestReview')}
                  </button>
                ) : null}
                <button type="button" className="btn btn--danger" onClick={() => setDeleting({ title: memory.title, from: memory.status, affected: memory.evidenceIds?.length ?? memory.evidenceCount })}>
                  <Icon name="trash" size={15} /> {t('memories.action.delete')}
                </button>
              </div>
              <div className="row-8">
                <button type="button" className="btn btn--sm" disabled={feedbackPending} onClick={() => void sendFeedback('useful')}>
                  {t('memories.action.markUseful')}
                </button>
                <button type="button" className="btn btn--sm" disabled={feedbackPending} onClick={() => void sendFeedback('incorrect')}>
                  {t('memories.action.markIncorrect')}
                </button>
                <button type="button" className="btn btn--sm" disabled={feedbackPending} onClick={() => void sendFeedback('stale')}>
                  {t('memories.action.markStaleFeedback')}
                </button>
              </div>
              {feedbackError ? <InlineError error={feedbackError} onDismiss={() => setFeedbackError(undefined)} /> : null}
            </div>
          </Card>
        </>
      ) : null}

      {transition && memory ? (
        <TransitionModal
          request={transition}
          memoryId={memory.id}
          revision={memory.revision}
          onClose={() => setTransition(undefined)}
          onDone={() => {
            announce(t('memories.transitionDone', { status: t(`status.${transition.to}` as MessageKey) }))
            onChanged()
            resource.reload()
          }}
        />
      ) : null}
      {deleting && memory ? (
        <DeleteModal
          request={deleting}
          memoryId={memory.id}
          revision={memory.revision}
          onClose={() => setDeleting(undefined)}
          onDone={() => {
            announce(t('memories.deleted'))
            onClose()
            onChanged()
          }}
        />
      ) : null}
    </Drawer>
  )
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export function MemoriesPage({ params }: { params: URLSearchParams }): ReactNode {
  const { t, locale, projectId, workspaceId } = useApp()

  const [filters, setFilters] = useState<Filters>(() => ({
    q: params.get('q') ?? '',
    mode: 'hybrid',
    scene: '',
    status: params.get('status') ?? '',
    kind: params.get('kind') ?? '',
    scope: params.get('scope') ?? '',
    agentId: params.get('agentId') ?? '',
    pageSize: 20,
  }))
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const debouncedQuery = useDebouncedValue(filters.q, 300)

  /* KPI deep links (e.g. `#/memories?status=verified`) win over local state. */
  useEffect(() => {
    const status = params.get('status') ?? ''
    const kind = params.get('kind') ?? ''
    const scope = params.get('scope') ?? ''
    const agentId = params.get('agentId') ?? ''
    const q = params.get('q') ?? ''
    setFilters(previous => {
      if (previous.status === status && previous.kind === kind && previous.scope === scope && previous.agentId === agentId && previous.q === q) {
        return previous
      }
      return { ...previous, status, kind, scope, agentId, q }
    })
    setPage(1)
  }, [params])

  const query: MemoryQuery = useMemo(
    () => ({
      projectId: projectId || undefined,
      workspaceId: workspaceId || undefined,
      status: (filters.status as MemoryStatus | '') || undefined,
      scene: (filters.scene || undefined) as MemoryQuery['scene'],
      kind: (filters.kind || undefined) as MemoryQuery['kind'],
      scope: (filters.scope || undefined) as MemoryQuery['scope'],
      mode: filters.mode,
      q: debouncedQuery || undefined,
      agentId: filters.agentId || undefined,
      page,
      pageSize: filters.pageSize,
    }),
    [projectId, workspaceId, filters, debouncedQuery, page],
  )

  const resource = useResource(signal => api.memories(query, signal), [JSON.stringify(query)])

  const columns: Array<Column<MemorySummary>> = [
    {
      key: 'title',
      header: t('memories.row.title'),
      render: memory => (
        <div className="stack-8">
          <span className="wrap-anywhere">{memory.title}</span>
          {memory.excerpt || memory.content ? <p className="excerpt">{memory.excerpt ?? memory.content}</p> : null}
        </div>
      ),
    },
    {
      key: 'status',
      header: t('common.status'),
      render: memory => <StatusBadge status={memory.status} />,
    },
    {
      key: 'scope',
      header: t('common.scope'),
      render: memory => <EnumBadge group="scope" value={memory.scope} />,
    },
    {
      key: 'evidence',
      header: t('common.evidenceCount'),
      numeric: true,
      render: memory => <MaybeValue value={memory.evidenceCount} />,
    },
    {
      key: 'updated',
      header: t('memories.row.updated'),
      render: memory => <span title={formatDateTime(memory.updatedAt, locale)}>{formatRelative(memory.updatedAt, locale)}</span>,
    },
    {
      key: 'open',
      header: t('common.actions'),
      render: memory => (
        <button
          type="button"
          className="btn btn--sm"
          aria-label={`${t('memories.openDetail')}: ${memory.title}`}
          onClick={event => {
            event.stopPropagation()
            setSelected(memory.id)
          }}
        >
          {t('common.open')}
        </button>
      ),
    },
  ]

  const pageResource = resource.data
  const hasRows = (pageResource?.items.length ?? 0) > 0

  return (
    <>
      <PageHeader title={t('memories.title')} subtitle={t('memories.subtitle')} />

      <Card title={t('common.filters')}>
        <div className="section-stack">
          <div className="toolbar">
            <Field label={t('memories.searchLabel')} htmlFor="memory-search">
              <TextInput
                id="memory-search"
                type="search"
                value={filters.q}
                onChange={value => {
                  setFilters(previous => ({ ...previous, q: value }))
                  setPage(1)
                }}
                placeholder={t('memories.searchPlaceholder')}
              />
            </Field>
            <SegmentedControl
              legend={t('memories.mode')}
              value={filters.mode}
              onChange={value => {
                setFilters(previous => ({ ...previous, mode: value as Filters['mode'] }))
                setPage(1)
              }}
              options={SEARCH_MODES.map(mode => ({ value: mode, label: t(`memories.mode.${mode}` as MessageKey) }))}
            />
            <Field label={t('memories.filter.scene')} htmlFor="filter-scene">
              <Select
                id="filter-scene"
                value={filters.scene}
                onChange={value => {
                  setFilters(previous => ({ ...previous, scene: value }))
                  setPage(1)
                }}
                options={labelOptions(SCENES, 'scene', t)}
              />
            </Field>
            <Field label={t('memories.filter.status')} htmlFor="filter-status">
              <Select
                id="filter-status"
                value={filters.status}
                onChange={value => {
                  setFilters(previous => ({ ...previous, status: value }))
                  setPage(1)
                }}
                options={labelOptions(MEMORY_STATUSES, 'status', t)}
              />
            </Field>
            <Field label={t('memories.filter.kind')} htmlFor="filter-kind">
              <Select
                id="filter-kind"
                value={filters.kind}
                onChange={value => {
                  setFilters(previous => ({ ...previous, kind: value }))
                  setPage(1)
                }}
                options={labelOptions(MEMORY_KINDS, 'kind', t)}
              />
            </Field>
            <Field label={t('memories.filter.scope')} htmlFor="filter-scope">
              <Select
                id="filter-scope"
                value={filters.scope}
                onChange={value => {
                  setFilters(previous => ({ ...previous, scope: value }))
                  setPage(1)
                }}
                options={labelOptions(MEMORY_SCOPES, 'scope', t)}
              />
            </Field>
            <Field label={t('memories.filter.agent')} htmlFor="filter-agent">
              <TextInput
                id="filter-agent"
                value={filters.agentId}
                onChange={value => {
                  setFilters(previous => ({ ...previous, agentId: value }))
                  setPage(1)
                }}
                placeholder={t('memories.filter.agentPlaceholder')}
              />
            </Field>
            <Field label={t('memories.filter.pageSize')} htmlFor="filter-page-size">
              <Select
                id="filter-page-size"
                value={String(filters.pageSize)}
                onChange={value => {
                  setFilters(previous => ({ ...previous, pageSize: Number(value) }))
                  setPage(1)
                }}
                options={PAGE_SIZES.map(size => ({ value: String(size), label: String(size) }))}
              />
            </Field>
            <button
              type="button"
              className="btn"
              onClick={() =>
                setFilters({ q: '', mode: 'hybrid', scene: '', status: '', kind: '', scope: '', agentId: '', pageSize: 20 })
              }
            >
              <Icon name="refresh" size={15} /> {t('memories.clearFilters')}
            </button>
          </div>
          {resource.refreshing ? <span className="muted">{t('common.loading')}</span> : null}
        </div>
      </Card>

      <Card
        title={t('memories.resultCount', { count: resource.data?.total ?? resource.data?.items.length ?? 0 })}
        flush
      >
        <AsyncView
          resource={resource}
          isEmpty={page => page.items.length === 0}
          emptyTitle={t('memories.emptyTitle')}
          emptyBody={t('memories.emptyBody')}
          skeletonRows={6}
        >
          {result => (
            <>
              <DataTable columns={columns} rows={result.items} rowKey={memory => memory.id} selectable onSelect={memory => setSelected(memory.id)} />
              {hasRows ? (
                <Pagination page={page} pageSize={filters.pageSize} total={result.total} onPage={setPage} />
              ) : null}
            </>
          )}
        </AsyncView>
      </Card>

      {selected ? <DetailDrawer memoryId={selected} onClose={() => setSelected(undefined)} onChanged={resource.reload} /> : null}
    </>
  )
}

export default MemoriesPage