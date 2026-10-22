/**
 * Router + page switch. Hash routing keeps the SPA usable when the Host serves
 * it from `/studio/` inside an iframe and there is no server-side rewrite.
 */
import type { ReactNode } from 'react'
import { useHashRoute } from './hooks'
import { useApp } from './store'
import { AppShell } from './components/AppShell'
import { ErrorBoundary } from './components/ErrorBoundary'
import { OverviewPage } from './pages/Overview'
import { MemoriesPage } from './pages/Memories'
import { EvidencePage } from './pages/Evidence'
import { ConflictsPage } from './pages/Conflicts'
import { AgentsPage } from './pages/Agents'
import { CapturePage } from './pages/Capture'
import { UsagePage } from './pages/Usage'
import { SettingsPage } from './pages/Settings'
import { DiagnosticsPage } from './pages/Diagnostics'

export function App(): ReactNode {
  const route = useHashRoute()
  const { t } = useApp()

  const page = (() => {
    switch (route.name) {
      case 'overview':
        return <OverviewPage />
      case 'memories':
        return <MemoriesPage params={route.params} />
      case 'evidence':
        return <EvidencePage params={route.params} />
      case 'conflicts':
        return <ConflictsPage />
      case 'agents':
        return <AgentsPage />
      case 'capture':
        return <CapturePage />
      case 'usage':
        return <UsagePage />
      case 'settings':
        return <SettingsPage />
      case 'diagnostics':
        return <DiagnosticsPage />
      default:
        return <OverviewPage />
    }
  })()

  return (
    <AppShell active={route.name}>
      <ErrorBoundary title={t('app.crashTitle')} body={t('app.crashBody')} reloadLabel={t('app.reload')}>
        {page}
      </ErrorBoundary>
    </AppShell>
  )
}