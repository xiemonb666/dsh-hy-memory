/**
 * Usage & Quality: recall counts, injected tokens, skipped queries, errors and
 * timeouts, the per-agent distribution, quality metrics, the estimated cost
 * (with an explicit `unknown` when the Host has no configured rate) and the A/B
 * benchmark link when the Host advertises one.
 */
import type { ReactNode } from 'react'
import { api } from '../api'
import { formatNumber, formatPercent, type MessageKey } from '../i18n'
import { useResource } from '../hooks'
import { useApp } from '../store'
import type { AgentUsage, UsageResponse } from '../types'
import {
  AsyncView,
  Card,
  DataTable,
  Icon,
  MaybeValue,
  Meter,
  Metric,
  PageHeader,
  Sparkline,
  type Column,
} from '../components/ui'

function KpiBlock({ data }: { data: UsageResponse }): ReactNode {
  const { t, locale } = useApp()
  const cards: Array<{ key: string; label: string; value: number | undefined }> = [
    { key: 'recalls', label: t('usage.recallCount'), value: data.recallCount },
    { key: 'tokens', label: t('usage.injectedTokens'), value: data.injectedTokens },
    { key: 'skipped', label: t('usage.skipped'), value: data.skippedQueries },
    { key: 'errors', label: t('usage.errors'), value: data.errors },
    { key: 'timeouts', label: t('usage.timeouts'), value: data.timeouts },
  ]
  return (
    <div className="grid grid--kpi">
      {cards.map(card => (
        <div className="kpi" key={card.key}>
          <p className="kpi__label">{card.label}</p>
          <span className="kpi__value">{card.value === undefined ? t('common.unknown') : formatNumber(card.value, locale)}</span>
        </div>
      ))}
    </div>
  )
}

function AgentTable({ rows }: { rows: AgentUsage[] }): ReactNode {
  const { t } = useApp()
  const columns: Array<Column<AgentUsage>> = [
    { key: 'agent', header: t('usage.agentColumn'), render: row => <span className="wrap-anywhere">{row.name ?? row.agentId}</span> },
    { key: 'recalls', header: t('usage.recallsColumn'), numeric: true, render: row => <MaybeValue value={row.recallCount} /> },
    { key: 'tokens', header: t('usage.tokensColumn'), numeric: true, render: row => <MaybeValue value={row.injectedTokens} /> },
    { key: 'skipped', header: t('usage.skippedColumn'), numeric: true, render: row => <MaybeValue value={row.skippedQueries} /> },
    { key: 'errors', header: t('usage.errorsColumn'), numeric: true, render: row => <MaybeValue value={row.errors} /> },
  ]
  if (rows.length === 0) return <p className="muted">{t('usage.perAgentEmpty')}</p>
  return <DataTable columns={columns} rows={rows} rowKey={row => row.agentId} />
}

function QualityBlock({ data }: { data: UsageResponse }): ReactNode {
  const { t, locale } = useApp()
  const quality = data.quality
  const hasAny = Object.values(quality).some(value => value !== undefined)
  if (!hasAny) return <p className="muted">{t('usage.qualityEmpty')}</p>

  const meters: Array<{ key: keyof typeof quality; label: MessageKey }> = [
    { key: 'verifiedRatio', label: 'usage.quality.verifiedRatio' },
    { key: 'staleRatio', label: 'usage.quality.staleRatio' },
    { key: 'conflictRate', label: 'usage.quality.conflictRate' },
    { key: 'evidenceCoverage', label: 'usage.quality.evidenceCoverage' },
    { key: 'retrievalPrecision', label: 'usage.quality.retrievalPrecision' },
  ]
  const counters: Array<{ key: keyof typeof quality; label: MessageKey }> = [
    { key: 'feedbackUseful', label: 'usage.quality.feedbackUseful' },
    { key: 'feedbackIncorrect', label: 'usage.quality.feedbackIncorrect' },
    { key: 'feedbackStale', label: 'usage.quality.feedbackStale' },
  ]

  return (
    <div className="section-stack">
      {meters.map(meter => (
        <Meter key={meter.key} ratio={quality[meter.key] as number | undefined} label={t(meter.label)} />
      ))}
      <div className="grid grid--3">
        {counters.map(counter => (
          <Metric
            key={counter.key}
            label={t(counter.label)}
            value={quality[counter.key] === undefined ? t('common.unknown') : formatNumber(quality[counter.key] as number, locale)}
          />
        ))}
      </div>
    </div>
  )
}

function CostBlock({ data }: { data: UsageResponse }): ReactNode {
  const { t, locale } = useApp()
  const cost = data.cost
  const rate = cost.ratePer1kTokensUsd
  const estimate = cost.estimatedUsd
  const rateKnown = cost.rateKnown === true || (cost.rateKnown === undefined && rate !== undefined && rate !== null)
  return (
    <div className="section-stack">
      <p className="muted">{t('usage.cost.body')}</p>
      <Metric
        label={t('usage.cost.rate')}
        value={
          rateKnown && rate !== undefined && rate !== null ? (
            `$${rate.toFixed(4)}`
          ) : (
            <span className="muted">{t('usage.cost.unknownRate')}</span>
          )
        }
      />
      <Metric
        label={t('usage.cost.estimated')}
        value={
          rateKnown && estimate !== undefined && estimate !== null ? (
            `$${estimate.toFixed(2)}`
          ) : (
            <span className="muted">{t('usage.cost.unknownRate')}</span>
          )
        }
      />
      {!rateKnown ? <span className="badge badge--warn">{t('common.unknown')}</span> : null}
      <p className="field__hint">{formatPercent(data.cacheHitRate, locale)} — {t('usage.cacheHitRate')}</p>
    </div>
  )
}

export function UsagePage(): ReactNode {
  const { t, projectId, capabilities } = useApp()
  const resource = useResource<UsageResponse>(signal => api.usage({ projectId: projectId || undefined }, signal), [projectId])
  const benchmarkUrl = resource.data?.benchmarkUrl ?? capabilities.benchmarkUrl

  return (
    <>
      <PageHeader
        title={t('usage.title')}
        subtitle={t('usage.subtitle')}
        actions={
          resource.data?.windowHours !== undefined ? (
            <span className="badge badge--neutral">{t('usage.window', { hours: resource.data.windowHours })}</span>
          ) : null
        }
      />

      <AsyncView resource={resource} skeletonRows={5}>
        {data => (
          <>
            <KpiBlock data={data} />
            <div className="grid grid--2">
              <Card title={t('usage.perAgent')}>
                <AgentTable rows={data.perAgent} />
              </Card>
              <Card title={t('usage.quality')}>
                <QualityBlock data={data} />
              </Card>
            </div>
            <div className="grid grid--2">
              <Card title={t('usage.cost')}>
                <CostBlock data={data} />
              </Card>
              <Card title={t('usage.benchmark')}>
                <div className="section-stack">
                  <p className="muted">{t('usage.benchmarkBody')}</p>
                  <div className="row-8">
                    <Sparkline
                      points={[data.recallCount ?? 0, data.injectedTokens ?? 0, data.skippedQueries ?? 0]}
                      ariaLabel={t('usage.title')}
                    />
                  </div>
                  {benchmarkUrl ? (
                    <a className="btn" href={benchmarkUrl} target="_blank" rel="noreferrer noopener">
                      <Icon name="external" size={15} /> {t('usage.benchmarkLink')}
                    </a>
                  ) : (
                    <p className="muted">{t('usage.benchmarkUnavailable')}</p>
                  )}
                </div>
              </Card>
            </div>
          </>
        )}
      </AsyncView>
    </>
  )
}

export default UsagePage