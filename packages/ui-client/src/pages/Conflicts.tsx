/**
 * Conflicts: side-by-side older/newer claim with qualifiers, evidence counts and
 * timestamps; a resolution form (Keep both / Supersede / Reject / Request
 * verification / Leave unresolved) with a mandatory reason; and a preview of the
 * resulting state (from the Host when it projects one, otherwise stated as
 * pending rather than guessed).
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ApiError, api } from '../api'
import { formatDateTime, formatNumber, type MessageKey } from '../i18n'
import { useResource } from '../hooks'
import { useApp } from '../store'
import {
  CONFLICT_RESOLUTIONS,
  CONFLICT_STATES,
  type ConflictCase,
  type ConflictClaimSide,
  type ConflictResolution,
  type ConflictResolveResult,
} from '../types'
import {
  AsyncView,
  Card,
  DataTable,
  Field,
  Icon,
  InlineError,
  Modal,
  PageHeader,
  Select,
  StatusBadge,
  Textarea,
  type Column,
} from '../components/ui'

function claimText(side: ConflictClaimSide): string {
  const claim = side.claim
  if (!claim) return ''
  return `${claim.subject} ${claim.predicate} ${claim.object}`.trim()
}

function ClaimPanel({ side, heading }: { side: ConflictClaimSide; heading: string }): ReactNode {
  const { t, locale } = useApp()
  const text = claimText(side)
  return (
    <div className="claim-card">
      <h3 className="claim-card__title">{heading}</h3>
      <div className="row-8">
        {side.status ? <StatusBadge status={side.status} /> : null}
        <span className="tag mono wrap-anywhere">{side.memoryId}</span>
      </div>
      {side.title ? <p className="wrap-anywhere">{side.title}</p> : null}
      {text === '' ? (
        <p className="muted">{t('conflicts.claimMissing')}</p>
      ) : (
        <p className="claim-triple wrap-anywhere">{text}</p>
      )}
      <div>
        <strong>{t('conflicts.qualifiers')}: </strong>
        {side.qualifiers && Object.keys(side.qualifiers).length > 0 ? (
          <span className="row-8">
            {Object.entries(side.qualifiers).map(([key, value]) => (
              <span className="tag" key={key}>
                {key}={value}
              </span>
            ))}
          </span>
        ) : (
          <span className="muted">{t('common.none')}</span>
        )}
      </div>
      <div>
        <strong>{t('conflicts.evidence')}: </strong>
        {side.evidenceCount === undefined ? <span className="muted">{t('common.unknown')}</span> : <span>{formatNumber(side.evidenceCount, locale)}</span>}
      </div>
      <div className="muted">
        {t('conflicts.updated')}: {formatDateTime(side.updatedAt, locale)}
      </div>
    </div>
  )
}

function ResolveModal({
  conflict,
  onClose,
  onResolved,
}: {
  conflict: ConflictCase
  onClose: () => void
  onResolved: (result: ConflictResolveResult, resolution: ConflictResolution) => void
}): ReactNode {
  const { t } = useApp()
  const [resolution, setResolution] = useState<ConflictResolution>('keep_both')
  const [reason, setReason] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [result, setResult] = useState<ConflictResolveResult | undefined>(undefined)
  const [reasonInvalid, setReasonInvalid] = useState(false)

  const submit = async () => {
    if (reason.trim() === '') {
      setReasonInvalid(true)
      return
    }
    setReasonInvalid(false)
    setPending(true)
    setError(undefined)
    try {
      const response = await api.resolveConflict(conflict.id, { resolution, reason: reason.trim() })
      setResult(response)
      onResolved(response, resolution)
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError({ message: String(caught), kind: 'offline' }))
    } finally {
      setPending(false)
    }
  }

  const projected = result?.result

  return (
    <Modal
      title={`${t('conflicts.resolve')} · ${conflict.id}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {result ? t('common.close') : t('common.cancel')}
          </button>
          {result ? null : (
            <button type="button" className="btn btn--primary" onClick={() => void submit()} disabled={pending}>
              {pending ? t('common.saving') : t('common.confirm')}
            </button>
          )}
        </>
      }
    >
      <div className="split">
        <ClaimPanel side={conflict.older} heading={t('conflicts.older')} />
        <ClaimPanel side={conflict.newer} heading={t('conflicts.newer')} />
      </div>

      <Field label={t('conflicts.resolution')} htmlFor="conflict-resolution" required>
        <Select
          id="conflict-resolution"
          value={resolution}
          onChange={value => setResolution(value as ConflictResolution)}
          options={CONFLICT_RESOLUTIONS.map(value => ({ value, label: t(`resolution.${value}` as MessageKey) }))}
        />
      </Field>

      <Field label={t('conflicts.reason')} htmlFor="conflict-reason" required error={reasonInvalid ? t('common.reasonRequired') : undefined}>
        <Textarea
          id="conflict-reason"
          value={reason}
          onChange={value => {
            setReason(value)
            if (value.trim() !== '') setReasonInvalid(false)
          }}
          placeholder={t('conflicts.reasonPlaceholder')}
          required
          invalid={reasonInvalid}
        />
      </Field>

      <Card title={t('conflicts.preview')}>
        {/*
          The resulting-state diff is only shown from Host data. Before the
          resolution is submitted there is no projected state to diff, so the
          panel states the pending decision instead of inventing one.
        */}
        {projected ? (
          <div className="table-wrap">
            <table className="table">
              <caption>{t('conflicts.previewResult')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('common.name')}</th>
                  <th scope="col">{t('conflicts.before')}</th>
                  <th scope="col">{t('conflicts.after')}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">{t('conflicts.older')}</th>
                  <td data-label={t('conflicts.before')}>
                    {conflict.older.status ? <StatusBadge status={conflict.older.status} /> : <span className="muted">{t('common.unknown')}</span>}
                  </td>
                  <td data-label={t('conflicts.after')}>
                    {projected.olderStatus ? <StatusBadge status={projected.olderStatus} /> : <span className="muted">{t('common.unknown')}</span>}
                  </td>
                </tr>
                <tr>
                  <th scope="row">{t('conflicts.newer')}</th>
                  <td data-label={t('conflicts.before')}>
                    {conflict.newer.status ? <StatusBadge status={conflict.newer.status} /> : <span className="muted">{t('common.unknown')}</span>}
                  </td>
                  <td data-label={t('conflicts.after')}>
                    {projected.newerStatus ? <StatusBadge status={projected.newerStatus} /> : <span className="muted">{t('common.unknown')}</span>}
                  </td>
                </tr>
                <tr>
                  <th scope="row">{t('conflicts.state')}</th>
                  <td data-label={t('conflicts.before')}>
                    <span className="badge badge--neutral">{t(`conflictState.${conflict.state}` as MessageKey)}</span>
                  </td>
                  <td data-label={t('conflicts.after')}>
                    {projected.state ? (
                      <span className="badge badge--ok">{t(`conflictState.${projected.state}` as MessageKey)}</span>
                    ) : (
                      <span className="muted">{t('common.unknown')}</span>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
            {projected.auditEventId ? <p className="field__hint mono">audit {projected.auditEventId}</p> : null}
          </div>
        ) : (
          <div className="preview-box">
            <span className="muted">{t('conflicts.previewPending')}</span>
            <span>
              {t('conflicts.resolution')}: <strong>{t(`resolution.${resolution}` as MessageKey)}</strong>
            </span>
            <span>
              {t('conflicts.reason')}: <strong>{reason.trim() === '' ? t('common.unknown') : reason.trim()}</strong>
            </span>
          </div>
        )}
      </Card>

      {error ? <InlineError error={error} onDismiss={() => setError(undefined)} /> : null}
    </Modal>
  )
}

export function ConflictsPage(): ReactNode {
  const { t, locale, projectId, announce } = useApp()
  const [state, setState] = useState('open')
  const [selected, setSelected] = useState<ConflictCase | undefined>(undefined)
  const [resolving, setResolving] = useState<ConflictCase | undefined>(undefined)

  const resource = useResource(
    signal => api.conflicts({ projectId: projectId || undefined, state: state || undefined }, signal),
    [projectId, state],
  )

  useEffect(() => {
    if (!selected) return
    const stillThere = resource.data?.find(item => item.id === selected.id)
    if (resource.data && !stillThere) setSelected(undefined)
  }, [resource.data, selected])

  const columns: Array<Column<ConflictCase>> = [
    {
      key: 'older',
      header: t('conflicts.older'),
      render: conflict => (
        <div className="stack-8">
          <span className="claim-triple wrap-anywhere">{claimText(conflict.older) || t('conflicts.claimMissing')}</span>
          {conflict.older.status ? <StatusBadge status={conflict.older.status} /> : null}
        </div>
      ),
    },
    {
      key: 'newer',
      header: t('conflicts.newer'),
      render: conflict => (
        <div className="stack-8">
          <span className="claim-triple wrap-anywhere">{claimText(conflict.newer) || t('conflicts.claimMissing')}</span>
          {conflict.newer.status ? <StatusBadge status={conflict.newer.status} /> : null}
        </div>
      ),
    },
    {
      key: 'state',
      header: t('conflicts.state'),
      render: conflict => (
        <span className={`badge ${conflict.state === 'open' ? 'badge--warn' : 'badge--neutral'}`}>
          {t(`conflictState.${conflict.state}` as MessageKey)}
        </span>
      ),
    },
    {
      key: 'updated',
      header: t('common.updated'),
      render: conflict => formatDateTime(conflict.newer.updatedAt ?? conflict.createdAt, locale),
    },
    {
      key: 'actions',
      header: t('common.actions'),
      render: conflict => (
        <div className="table__actions">
          <button
            type="button"
            className="btn btn--sm"
            onClick={event => {
              event.stopPropagation()
              setSelected(conflict)
            }}
          >
            {t('common.view')}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={event => {
              event.stopPropagation()
              setResolving(conflict)
            }}
          >
            {t('conflicts.resolve')}
          </button>
        </div>
      ),
    },
  ]

  return (
    <>
      <PageHeader title={t('conflicts.title')} subtitle={t('conflicts.subtitle')} />

      <Card title={t('common.filters')}>
        <div className="toolbar">
          <Field label={t('conflicts.filterState')} htmlFor="conflict-state-filter">
            <Select
              id="conflict-state-filter"
              value={state}
              onChange={setState}
              options={[{ value: '', label: t('common.all') }, ...CONFLICT_STATES.map(value => ({ value, label: t(`conflictState.${value}` as MessageKey) }))]}
            />
          </Field>
          <button type="button" className="btn" onClick={resource.reload}>
            <Icon name="refresh" size={15} /> {t('common.refresh')}
          </button>
        </div>
      </Card>

      <Card title={t('conflicts.title')} flush>
        <AsyncView
          resource={resource}
          isEmpty={cases => cases.length === 0}
          emptyTitle={t('conflicts.emptyTitle')}
          emptyBody={t('conflicts.emptyBody')}
          skeletonRows={5}
        >
          {cases => (
            <DataTable
              columns={columns}
              rows={cases}
              rowKey={conflict => conflict.id}
              selectable
              selectedKey={selected?.id}
              onSelect={setSelected}
            />
          )}
        </AsyncView>
      </Card>

      {selected ? (
        <Card title={`${t('conflicts.detail')} · ${selected.id}`}>
          <div className="section-stack">
            <div className="row-8">
              <span className="badge badge--neutral">{t(`conflictState.${selected.state}` as MessageKey)}</span>
              {selected.detail ? <span className="muted wrap-anywhere">{selected.detail}</span> : null}
            </div>
            <div className="split">
              <ClaimPanel side={selected.older} heading={t('conflicts.older')} />
              <ClaimPanel side={selected.newer} heading={t('conflicts.newer')} />
            </div>
            {selected.reason ? (
              <p>
                <strong>{t('common.reason')}: </strong>
                {selected.reason}
              </p>
            ) : null}
            {selected.resolvedAt ? (
              <p className="muted">
                {t('conflicts.resolvedAt')}: {formatDateTime(selected.resolvedAt, locale)}
              </p>
            ) : null}
            <div className="row-8">
              <button type="button" className="btn btn--primary" onClick={() => setResolving(selected)}>
                {t('conflicts.resolve')}
              </button>
              <button type="button" className="btn" onClick={() => setSelected(undefined)}>
                {t('common.close')}
              </button>
            </div>
          </div>
        </Card>
      ) : null}

      {resolving ? (
        <ResolveModal
          conflict={resolving}
          onClose={() => setResolving(undefined)}
          onResolved={(_result, resolution) => {
            announce(t('conflicts.resolvedToast', { resolution: t(`resolution.${resolution}` as MessageKey) }))
            resource.reload()
          }}
        />
      ) : null}
    </>
  )
}

export default ConflictsPage