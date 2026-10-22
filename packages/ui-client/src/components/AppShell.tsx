/**
 * Application shell: the nine-entry navigation rail (icons-only at tablet
 * width, a focus-trapped drawer on mobile) and the header with project /
 * workspace selectors, the backend health pill, the capture pause control, and
 * the language and theme toggles.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { FIXTURE_MODE } from '../api'
import { LOCALES, type MessageKey } from '../i18n'
import { hrefFor, useMediaQuery, type RouteName } from '../hooks'
import { useApp } from '../store'
import { Badge, Drawer, Icon, type IconName, SegmentedControl, Select } from './ui'

interface NavItem {
  name: RouteName
  icon: IconName
  label: MessageKey
}

export const NAV_ITEMS: readonly NavItem[] = [
  { name: 'overview', icon: 'overview', label: 'nav.overview' },
  { name: 'memories', icon: 'memories', label: 'nav.memories' },
  { name: 'evidence', icon: 'evidence', label: 'nav.evidence' },
  { name: 'conflicts', icon: 'conflicts', label: 'nav.conflicts' },
  { name: 'agents', icon: 'agents', label: 'nav.agents' },
  { name: 'capture', icon: 'capture', label: 'nav.capture' },
  { name: 'usage', icon: 'usage', label: 'nav.usage' },
  { name: 'settings', icon: 'settings', label: 'nav.settings' },
  { name: 'diagnostics', icon: 'diagnostics', label: 'nav.diagnostics' },
]

function Navigation({ active, onNavigate }: { active: RouteName; onNavigate?: () => void }): ReactNode {
  const { t } = useApp()
  return (
    <nav className="app__nav" aria-label={t('app.navLabel')}>
      <div className="brand">
        <p className="brand__name">{t('app.title')}</p>
        <p className="brand__sub">{t('app.subtitle')}</p>
      </div>
      <ul className="nav__list">
        {NAV_ITEMS.map(item => (
          <li key={item.name}>
            <a
              className="nav__link"
              href={hrefFor(item.name)}
              aria-current={active === item.name ? 'page' : undefined}
              onClick={onNavigate}
            >
              <span className="nav__icon">
                <Icon name={item.icon} />
              </span>
              <span className="nav__label">{t(item.label)}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

function HealthPill(): ReactNode {
  const { t, healthState, healthError, health } = useApp()
  const tone = healthState === 'ok' ? 'ok' : healthState === 'unknown' ? 'warn' : 'bad'
  const label =
    healthState === 'ok'
      ? t('header.healthOk')
      : healthState === 'degraded'
        ? t('header.healthDegraded')
        : healthState === 'offline'
          ? t('header.healthOffline')
          : t('header.healthUnknown')
  const detail = health?.reason ?? health?.worker?.reason ?? healthError?.message ?? undefined
  return (
    <a className={`pill pill--${tone}`} href={hrefFor('diagnostics')} title={detail ?? label}>
      <span className="pill__dot" aria-hidden="true" />
      <span>{`${t('header.health')}: ${label}`}</span>
    </a>
  )
}

function ProjectPicker(): ReactNode {
  const { t, projects, projectsLoading, projectsError, reloadProjects, projectId, setProjectId, workspaceId, setWorkspaceId } = useApp()
  const workspaces = projects.find(project => project.id === projectId)?.workspaces ?? []

  if (projectsError) {
    return (
      <div className="header__group">
        <span className="header__label">{t('header.project')}</span>
        <Badge tone="warn" title={projectsError.message}>
          {projectsError.forbidden ? t('state.forbiddenTitle') : projectsError.degraded ? t('state.degradedTitle') : t('state.offlineTitle')}
        </Badge>
        <button type="button" className="btn btn--sm" onClick={reloadProjects}>
          {t('common.retry')}
        </button>
      </div>
    )
  }

  return (
    <div className="header__group">
      <label className="header__label" htmlFor="header-project">
        {t('header.project')}
      </label>
      <Select
        id="header-project"
        value={projectId}
        disabled={projectsLoading}
        onChange={setProjectId}
        options={[
          { value: '', label: projectsLoading ? t('common.loading') : t('header.allProjects') },
          ...projects.map(project => ({ value: project.id, label: project.name ?? project.id })),
        ]}
      />
      <label className="header__label" htmlFor="header-workspace">
        {t('header.workspace')}
      </label>
      <Select
        id="header-workspace"
        value={workspaceId}
        disabled={projectsLoading || workspaces.length === 0}
        onChange={setWorkspaceId}
        options={[
          { value: '', label: t('header.allWorkspaces') },
          ...workspaces.map(workspace => ({ value: workspace.id, label: workspace.name ?? workspace.rootAlias ?? workspace.id })),
        ]}
      />
    </div>
  )
}

function PauseButton(): ReactNode {
  const { t, paused, pausePending, togglePause } = useApp()
  const label = paused ? t('header.resume') : t('header.pause')
  return (
    <button
      type="button"
      className="icon-btn"
      onClick={() => {
        void togglePause()
      }}
      disabled={pausePending}
      aria-pressed={paused === true}
      aria-label={label}
      title={`${label} — ${t('header.pauseHint')}`}
    >
      <Icon name={paused ? 'play' : 'pause'} />
    </button>
  )
}

function PreferenceToggles(): ReactNode {
  const { t, locale, setLocale, theme, setTheme } = useApp()
  return (
    <>
      <SegmentedControl
        legend={t('header.language')}
        value={locale}
        onChange={value => setLocale(value as (typeof LOCALES)[number])}
        options={LOCALES.map(item => ({ value: item, label: item === 'en' ? 'EN' : '中文' }))}
      />
      <SegmentedControl
        legend={t('header.theme')}
        value={theme}
        onChange={value => setTheme(value as 'light' | 'dark' | 'system')}
        options={[
          { value: 'light', label: t('header.themeLight') },
          { value: 'dark', label: t('header.themeDark') },
          { value: 'system', label: t('header.themeSystem') },
        ]}
      />
    </>
  )
}

export function AppShell({ active, children }: { active: RouteName; children: ReactNode }): ReactNode {
  const { t } = useApp()
  const [navOpen, setNavOpen] = useState(false)
  const isMobile = useMediaQuery('(max-width: 640px)')

  return (
    <div className="app">
      <a
        className="skip-link"
        href="#main-content"
        onClick={event => {
          // Hash routing owns `location.hash`; move focus without navigating.
          event.preventDefault()
          const target = document.getElementById('main-content')
          target?.focus()
          target?.scrollIntoView({ block: 'start' })
        }}
      >
        {t('app.skipToContent')}
      </a>
      {isMobile ? null : <Navigation active={active} />}
      {isMobile && navOpen ? (
        <Drawer title={t('app.navLabel')} side="left" onClose={() => setNavOpen(false)}>
          <ul className="nav__list">
            {NAV_ITEMS.map(item => (
              <li key={item.name}>
                <a
                  className="nav__link"
                  href={hrefFor(item.name)}
                  aria-current={active === item.name ? 'page' : undefined}
                  onClick={() => setNavOpen(false)}
                >
                  <span className="nav__icon">
                    <Icon name={item.icon} />
                  </span>
                  <span className="nav__label">{t(item.label)}</span>
                </a>
              </li>
            ))}
          </ul>
        </Drawer>
      ) : null}
      <div className="app__main">
        {FIXTURE_MODE ? (
          <div className="banner" role="status">
            <Icon name="alert" />
            <span>
              <strong>{t('app.fixtureBanner')}</strong> — {t('app.fixtureBannerDetail')}
            </span>
          </div>
        ) : null}
        <header className="header">
          <div className="header__group">
            {isMobile ? (
              <button
                type="button"
                className="icon-btn"
                aria-expanded={navOpen}
                aria-label={navOpen ? t('nav.closeMenu') : t('nav.openMenu')}
                onClick={() => setNavOpen(true)}
              >
                <Icon name="menu" />
              </button>
            ) : null}
            <ProjectPicker />
          </div>
          <div className="header__spacer" />
          <div className="header__group">
            <HealthPill />
            <PauseButton />
            <PreferenceToggles />
          </div>
        </header>
        <main className="app__content" id="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  )
}