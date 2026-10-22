/**
 * Overview page: KPI cards (each linking to the filtered explorer), the
 * retrieval/capture trend chart, memory health, recent memories and the job
 * summary. Every number comes from `GET /api/overview`; a missing field is
 * rendered as `unknown` rather than a placeholder figure.
 */
import type { ReactNode } from 'react'
import { api } from '../api'
import { formatNumber } from '../i18n'
import { hrefFor, useResource } from '../hooks'
import { useApp } from '../store'
import type { MemorySummary, OverviewResponse, TrendPoint } from '../types'
import {
  AsyncView,
  Card,
  EnumBadge,
  Icon,
  Metric,
  PageHeader,
  Sparkline,
  StatusBadge,
  TrendChart,
} from '../components/ui'

function trendValues(points: TrendPoint[]): number[] {
  return points.map(point => point.value)
}

function KpiCard({
  label,
  value,
  hint,
  href,
  openLabel,
}: {
  label: string
  value: number | undefined
  hint: string
  href: string
  openLabel: string
}): ReactNode {
  const { t, locale } = useApp()
  return (
    <a className="kpi" href={href} aria-label={`${label}: ${value === undefined ? t('common.unknown') : formatNumber(value, locale)} — ${openLabel}`}>
      <p className="kpi__label">{label}</p>
      <span className="kpi__value">{value === undefined ? t('common.unknown') : formatNumber(value, locale)}</span>
      <p className="kpi__hint">
        <Icon name="arrow-right" size={13} /> {hint}
      </p>
    </a>
  )
}

function RecentRow({ memory }: { memory: MemorySummary }): ReactNode {
  const { locale } = useApp()
  return (
    <li className="inline-list__item">
      <div className="row-8">
        <StatusBadge status={memory.status} />
        {memory.scene ? <EnumBadge group="scene" value={memory.scene} /> : null}
        {memory.kind ? <EnumBadge group="kind" value={memory.kind} /> : null}
      </div>
      <a href={hrefFor('memories', { q: memory.title })} className="wrap-anywhere">
        {memory.title}
      </a>
      <span className="muted mono">
        {memory.id} · {new Date(memory.updatedAt).toLocaleString(locale)}
        {memory.evidenceCount !== undefined ? ` · ${memory.evidenceCount} evidence` : ''}
      </span>
    </li>
  )
}

function HealthBlock({ data }: { data: OverviewResponse }): ReactNode {
  const { t, locale } = useApp()
  const stale = data.health.stale
  const conflicted = data.health.conflicted
  const errors = data.health.errors
  return (
    <Card title={t('overview.health.title')}>
      <div className="stack-8">
        <a className="metric" href={hrefFor('memories', { status: 'stale' })}>
          <span className="metric__label">{t('overview.health.stale')}</span>
          <span className="metric__value">{stale === undefined ? t('common.unknown') : formatNumber(stale, locale)}</span>
        </a>
        <a className="metric" href={hrefFor('memories', { status: 'conflicted' })}>
          <span className="metric__label">{t('overview.health.conflicted')}</span>
          <span className="metric__value">{conflicted === undefined ? t('common.unknown') : formatNumber(conflicted, locale)}</span>
        </a>
        <div className="metric">
          <span className="metric__label">{t('overview.health.errors')}</span>
          <span className="metric__value">{errors === undefined ? t('common.unknown') : formatNumber(errors, locale)}</span>
        </div>
      </div>
    </Card>
  )
}

function JobBlock({ data }: { data: OverviewResponse }): ReactNode {
  const { t, locale } = useApp()
  const entries = Object.entries(data.jobs.byStatus)
  return (
    <Card
      title={t('overview.jobs.title')}
      actions={
        <a className="btn btn--sm" href={hrefFor('capture')}>
          {t('overview.jobs.viewAll')}
        </a>
      }
    >
      <div className="stack-8">
        <Metric label={t('overview.jobs.total')} value={data.jobs.total === undefined ? t('common.unknown') : formatNumber(data.jobs.total, locale)} />
        <Metric
          label={t('overview.jobs.failed')}
          value={data.jobs.failed24h === undefined ? t('common.unknown') : formatNumber(data.jobs.failed24h, locale)}
        />
        <Metric label={t('overview.jobs.oldest')} value={data.jobs.oldestQueuedAt ?? t('common.unknown')} />
        {entries.length > 0 ? (
          <div className="row-8">
            {entries.map(([status, count]) => (
              <span key={status} className="tag">
                {status}: {count}
              </span>
            ))}
          </div>
        ) : (
          <p className="muted">{t('overview.jobs.empty')}</p>
        )}
      </div>
    </Card>
  )
}

export function OverviewPage(): ReactNode {
  const { t, locale, projectId, workspaceId } = useApp()
  const resource = useResource<OverviewResponse>(
    signal => api.overview({ projectId: projectId || undefined, workspaceId: workspaceId || undefined }, signal),
    [projectId, workspaceId],
  )

  const data = resource.data

  return (
    <>
      <PageHeader title={t('overview.title')} subtitle={t('overview.subtitle')} />
      <AsyncView resource={resource} skeletonRows={5}>
        {overview => (
          <>
            <div className="grid grid--kpi">
              <KpiCard
                label={t('overview.kpi.total')}
                value={overview.counts.total}
                hint={t('overview.kpi.totalHint')}
                href={hrefFor('memories')}
                openLabel={t('overview.kpi.open')}
              />
              <KpiCard
                label={t('overview.kpi.verified')}
                value={overview.counts.verified}
                hint={t('overview.kpi.verifiedHint')}
                href={hrefFor('memories', { status: 'verified' })}
                openLabel={t('overview.kpi.open')}
              />
              <KpiCard
                label={t('overview.kpi.needsReview')}
                value={overview.counts.needsReview}
                hint={t('overview.kpi.needsReviewHint')}
                href={hrefFor('memories', { status: 'needs_review' })}
                openLabel={t('overview.kpi.open')}
              />
              <KpiCard
                label={t('overview.kpi.tokens')}
                value={overview.usage.injectedTokens24h}
                hint={t('overview.kpi.tokensHint')}
                href={hrefFor('usage')}
                openLabel={t('overview.kpi.open')}
              />
            </div>

            <div className="grid grid--2">
              <Card title={t('overview.trend.title')}>
                <TrendChart
                  ariaLabel={t('overview.trend.title')}
                  emptyLabel={t('overview.trend.empty')}
                  series={[
                    {
                      label: t('overview.trend.retrieval'),
                      color: 'var(--hy-accent)',
                      points: trendValues(overview.trend.retrieval),
                    },
                    {
                      label: t('overview.trend.capture'),
                      color: 'var(--hy-ok)',
                      points: trendValues(overview.trend.capture),
                    },
                  ]}
                />
              </Card>
              <div className="section-stack">
                <HealthBlock data={overview} />
                <Card title={t('overview.usage.title')}>
                  <div className="stack-8">
                    <Metric
                      label={t('overview.usage.recalls')}
                      value={overview.usage.recallCount24h === undefined ? t('common.unknown') : formatNumber(overview.usage.recallCount24h, locale)}
                    />
                    <Metric
                      label={t('overview.usage.skipped')}
                      value={overview.usage.skippedQueries24h === undefined ? t('common.unknown') : formatNumber(overview.usage.skippedQueries24h, locale)}
                    />
                    <Metric
                      label={t('overview.usage.errors')}
                      value={overview.usage.errors24h === undefined ? t('common.unknown') : formatNumber(overview.usage.errors24h, locale)}
                    />
                    <Metric
                      label={t('overview.usage.timeouts')}
                      value={overview.usage.timeouts24h === undefined ? t('common.unknown') : formatNumber(overview.usage.timeouts24h, locale)}
                    />
                    <div className="row-8">
                      <Sparkline
                        points={trendValues(overview.trend.retrieval)}
                        ariaLabel={t('overview.trend.retrieval')}
                      />
                      <Sparkline
                        points={trendValues(overview.trend.capture)}
                        color="var(--hy-ok)"
                        ariaLabel={t('overview.trend.capture')}
                      />
                    </div>
                  </div>
                </Card>
              </div>
            </div>

            <div className="grid grid--2">
              <Card
                title={t('overview.recent.title')}
                actions={
                  <a className="btn btn--sm" href={hrefFor('memories')}>
                    {t('overview.recent.viewAll')}
                  </a>
                }
              >
                {overview.recent.length === 0 ? (
                  <p className="muted">{t('overview.recent.empty')}</p>
                ) : (
                  <ul className="inline-list">
                    {overview.recent.map(memory => (
                      <RecentRow key={memory.id} memory={memory} />
                    ))}
                  </ul>
                )}
              </Card>
              <JobBlock data={overview} />
            </div>
          </>
        )}
      </AsyncView>
      {data && resource.error ? (
        <p className="muted">
          {t('state.errorTitle')}: {resource.error.message}
        </p>
      ) : null}
    </>
  )
}

export default OverviewPage