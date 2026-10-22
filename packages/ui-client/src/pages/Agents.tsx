/**
 * Agents & Permissions: the agent tree/table (role, project/workspace, last
 * recall, last denial reason), the grant editor with a preview of the exact
 * change, per-grant revocation, and a confirmed revoke-all.
 */
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ApiError, api } from '../api'
import { formatDateTime, type MessageKey } from '../i18n'
import { useResource } from '../hooks'
import { useApp } from '../store'
import { GRANT_ACTIONS, type AgentSummary, type Grant, type GrantAction } from '../types'
import {
  AsyncView,
  Card,
  Checkbox,
  DataTable,
  EnumBadge,
  Field,
  Icon,
  InlineError,
  Modal,
  PageHeader,
  Select,
  TextInput,
  type Column,
} from '../components/ui'

interface AgentNode extends AgentSummary {
  children: AgentNode[]
}

/** Build the parent/child agent tree from `parentAgentId` links. */
function buildTree(agents: AgentSummary[]): AgentNode[] {
  const nodes = new Map<string, AgentNode>()
  for (const agent of agents) nodes.set(agent.id, { ...agent, children: [] })
  const roots: AgentNode[] = []
  for (const node of nodes.values()) {
    const parent = node.parentAgentId ? nodes.get(node.parentAgentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

function flatten(nodes: AgentNode[], depth = 0): Array<{ agent: AgentNode; depth: number }> {
  const rows: Array<{ agent: AgentNode; depth: number }> = []
  for (const node of nodes) {
    rows.push({ agent: node, depth })
    rows.push(...flatten(node.children, depth + 1))
  }
  return rows
}

function AgentTable({ agents }: { agents: AgentSummary[] }): ReactNode {
  const { t, locale } = useApp()
  const rows = useMemo(() => flatten(buildTree(agents)), [agents])

  const columns: Array<Column<{ agent: AgentNode; depth: number }>> = [
    {
      key: 'agent',
      header: t('agents.column.agent'),
      render: row => (
        <span style={{ paddingLeft: row.depth * 16 }} className="wrap-anywhere">
          {row.depth > 0 ? <span aria-hidden="true">↳ </span> : null}
          <strong>{row.agent.name ?? row.agent.id}</strong>
          {row.agent.name ? <span className="muted mono"> · {row.agent.id}</span> : null}
        </span>
      ),
    },
    {
      key: 'role',
      header: t('agents.column.role'),
      render: row => (row.agent.role ? <EnumBadge group="role" value={row.agent.role} /> : <span className="muted">{t('common.unknown')}</span>),
    },
    {
      key: 'scope',
      header: t('agents.column.project'),
      render: row => (
        <span className="mono wrap-anywhere">
          {row.agent.projectId ?? t('common.unknown')}
          {row.agent.workspaceId ? ` / ${row.agent.workspaceId}` : ''}
        </span>
      ),
    },
    {
      key: 'recall',
      header: t('agents.column.lastRecall'),
      render: row => formatDateTime(row.agent.lastRecallAt, locale),
    },
    {
      key: 'denial',
      header: t('agents.column.lastDenial'),
      render: row =>
        row.agent.lastDenialReason ? (
          <span className="wrap-anywhere">{row.agent.lastDenialReason}</span>
        ) : (
          <span className="muted">{t('agents.denialNone')}</span>
        ),
    },
    {
      key: 'grants',
      header: t('agents.column.grants'),
      numeric: true,
      render: row => (row.agent.grantCount === undefined ? <span className="muted">{t('common.unknown')}</span> : String(row.agent.grantCount)),
    },
    {
      key: 'sessions',
      header: t('agents.column.sessions'),
      numeric: true,
      render: row => (row.agent.sessionCount === undefined ? <span className="muted">{t('common.unknown')}</span> : String(row.agent.sessionCount)),
    },
  ]

  return <DataTable columns={columns} rows={rows} rowKey={row => row.agent.id} />
}

function GrantEditor({ agents, onCreated }: { agents: AgentSummary[]; onCreated: () => void }): ReactNode {
  const { t, announce } = useApp()
  const [subjectId, setSubjectId] = useState('')
  const [objectScope, setObjectScope] = useState('')
  const [action, setAction] = useState<GrantAction>('read')
  const [expiresAt, setExpiresAt] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [invalid, setInvalid] = useState(false)

  const previewSubject = subjectId || t('agents.placeholderSubject')
  const previewScope = objectScope || t('agents.placeholderScope')
  const previewExpiry = expiresAt ? t('agents.grantExpirySuffix', { date: expiresAt }) : ''

  const submit = async () => {
    if (subjectId.trim() === '' || objectScope.trim() === '') {
      setInvalid(true)
      setError(new ApiError({ message: t('agents.invalidGrant'), kind: 'http', status: 400 }))
      return
    }
    setInvalid(false)
    setPending(true)
    setError(undefined)
    try {
      await api.createGrant({
        subjectId: subjectId.trim(),
        objectScope: objectScope.trim(),
        action,
        ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      })
      announce(t('agents.grantCreated'))
      setObjectScope('')
      setExpiresAt('')
      onCreated()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError({ message: String(caught), kind: 'offline' }))
    } finally {
      setPending(false)
    }
  }

  return (
    <Card title={t('agents.grantEditor')}>
      <div className="section-stack">
        <div className="toolbar">
          <Field label={t('agents.grantSubject')} htmlFor="grant-subject" required>
            <Select
              id="grant-subject"
              value={subjectId}
              onChange={setSubjectId}
              options={[{ value: '', label: t('agents.placeholderSubject') }, ...agents.map(agent => ({ value: agent.id, label: agent.name ?? agent.id }))]}
            />
          </Field>
          <Field label={t('agents.grantScope')} htmlFor="grant-scope" required error={invalid && objectScope.trim() === '' ? t('common.required') : undefined}>
            <TextInput
              id="grant-scope"
              value={objectScope}
              onChange={setObjectScope}
              placeholder={t('agents.grantScopePlaceholder')}
              required
              invalid={invalid && objectScope.trim() === ''}
            />
          </Field>
          <Field label={t('agents.grantAction')} htmlFor="grant-action" required>
            <Select
              id="grant-action"
              value={action}
              onChange={value => setAction(value as GrantAction)}
              options={GRANT_ACTIONS.map(value => ({ value, label: t(`action.${value}` as MessageKey) }))}
            />
          </Field>
          <Field label={t('agents.grantExpiry')} htmlFor="grant-expiry" hint={t('agents.grantExpiryHint')}>
            <TextInput id="grant-expiry" type="datetime-local" value={expiresAt} onChange={setExpiresAt} />
          </Field>
        </div>

        <div className="preview-box">
          <strong>{t('agents.grantPreview')}</strong>
          <span>
            {t('agents.grantPreviewBody', {
              action: t(`action.${action}` as MessageKey),
              scope: previewScope,
              subject: previewSubject,
              expiry: previewExpiry,
            })}
          </span>
        </div>

        <div className="row-8">
          <button type="button" className="btn btn--primary" onClick={() => void submit()} disabled={pending}>
            <Icon name="check" size={15} /> {pending ? t('common.saving') : t('agents.grantCreate')}
          </button>
        </div>

        {error ? <InlineError error={error} onDismiss={() => setError(undefined)} /> : null}
      </div>
    </Card>
  )
}

function GrantTable({ grants, onRevoked }: { grants: Grant[]; onRevoked: () => void }): ReactNode {
  const { t, locale, announce } = useApp()
  const [revoking, setRevoking] = useState<Grant | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | undefined>(undefined)

  const columns: Array<Column<Grant>> = [
    { key: 'subject', header: t('agents.grantSubject'), render: grant => <span className="mono wrap-anywhere">{grant.subjectId}</span> },
    { key: 'scope', header: t('agents.grantScope'), render: grant => <span className="mono wrap-anywhere">{grant.objectScope}</span> },
    { key: 'action', header: t('agents.grantAction'), render: grant => <EnumBadge group="action" value={grant.action} /> },
    {
      key: 'expires',
      header: t('agents.expiresAt'),
      render: grant => (grant.expiresAt === undefined || grant.expiresAt === null ? t('common.never') : formatDateTime(grant.expiresAt, locale)),
    },
    { key: 'issuer', header: t('agents.issuer'), render: grant => <span className="mono">{grant.issuer ?? t('common.unknown')}</span> },
    {
      key: 'actions',
      header: t('common.actions'),
      render: grant => (
        <button type="button" className="btn btn--sm btn--danger" onClick={() => setRevoking(grant)}>
          {t('agents.revoke')}
        </button>
      ),
    },
  ]

  const confirmRevoke = async () => {
    if (!revoking) return
    setPending(true)
    setError(undefined)
    try {
      await api.deleteGrant(revoking.id)
      announce(t('agents.grantRevoked'))
      setRevoking(undefined)
      onRevoked()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError({ message: String(caught), kind: 'offline' }))
    } finally {
      setPending(false)
    }
  }

  if (grants.length === 0) return <p className="muted">{t('agents.grantsEmpty')}</p>

  return (
    <>
      <DataTable columns={columns} rows={grants} rowKey={grant => grant.id} />
      {revoking ? (
        <Modal
          title={t('agents.revokeOneTitle')}
          onClose={() => setRevoking(undefined)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setRevoking(undefined)}>
                {t('common.cancel')}
              </button>
              <button type="button" className="btn btn--danger" onClick={() => void confirmRevoke()} disabled={pending}>
                {pending ? t('common.saving') : t('agents.revoke')}
              </button>
            </>
          }
        >
          <p>{t('agents.revokeOneBody', { action: t(`action.${revoking.action}` as MessageKey), scope: revoking.objectScope })}</p>
          {error ? <InlineError error={error} onDismiss={() => setError(undefined)} /> : null}
        </Modal>
      ) : null}
    </>
  )
}

function RevokeAll({ grants, onDone }: { grants: Grant[]; onDone: () => void }): ReactNode {
  const { t, announce } = useApp()
  const [open, setOpen] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | undefined>(undefined)

  const revokeAll = async () => {
    setPending(true)
    setError(undefined)
    let revoked = 0
    try {
      for (const grant of grants) {
        await api.deleteGrant(grant.id)
        revoked++
      }
      announce(t('agents.revokeAllDone', { count: revoked }))
      setOpen(false)
      setAcknowledged(false)
      onDone()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError({ message: String(caught), kind: 'offline' }))
      if (revoked > 0) onDone()
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <button type="button" className="btn btn--danger" onClick={() => setOpen(true)} disabled={grants.length === 0}>
        <Icon name="trash" size={15} /> {t('agents.revokeAll')}
      </button>
      {open ? (
        <Modal
          title={t('agents.revokeAllTitle')}
          onClose={() => setOpen(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                {t('common.cancel')}
              </button>
              <button type="button" className="btn btn--danger" onClick={() => void revokeAll()} disabled={pending || !acknowledged}>
                {pending ? t('common.saving') : t('agents.revokeAllConfirm', { count: grants.length })}
              </button>
            </>
          }
        >
          <p>{t('agents.revokeAllBody', { count: grants.length })}</p>
          <Checkbox id="revoke-all-ack" checked={acknowledged} onChange={setAcknowledged} label={t('memories.delete.acknowledge')} />
          {error ? <InlineError error={error} onDismiss={() => setError(undefined)} /> : null}
        </Modal>
      ) : null}
    </>
  )
}

export function AgentsPage(): ReactNode {
  const { t, projectId } = useApp()
  const agents = useResource(signal => api.agents({ projectId: projectId || undefined }, signal), [projectId])
  const grants = useResource(signal => api.grants({ projectId: projectId || undefined }, signal), [projectId])

  return (
    <>
      <PageHeader title={t('agents.title')} subtitle={t('agents.subtitle')} />

      <Card
        title={t('agents.column.agent')}
        actions={
          <button type="button" className="btn btn--sm" onClick={agents.reload}>
            <Icon name="refresh" size={15} /> {t('common.refresh')}
          </button>
        }
        flush
      >
        <AsyncView
          resource={agents}
          isEmpty={list => list.length === 0}
          emptyTitle={t('agents.emptyTitle')}
          emptyBody={t('agents.emptyBody')}
          skeletonRows={5}
        >
          {list => <AgentTable agents={list} />}
        </AsyncView>
      </Card>

      <GrantEditor agents={agents.data ?? []} onCreated={grants.reload} />

      <Card
        title={t('agents.grantsTitle')}
        actions={<RevokeAll grants={grants.data ?? []} onDone={grants.reload} />}
        flush
      >
        <AsyncView resource={grants} isEmpty={list => list.length === 0} skeletonRows={4}>
          {list => <GrantTable grants={list} onRevoked={grants.reload} />}
        </AsyncView>
      </Card>
    </>
  )
}

export default AgentsPage