/**
 * Application store: locale, theme, project/workspace selection, backend health
 * polling, capability advertisement and the shared `aria-live` announcer.
 *
 * All values come from the Host (`/api/studio-config`, `/api/projects`,
 * `/api/health`) or from local user preference; nothing is inferred from mock
 * data unless the build explicitly opted into fixture mode.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ApiError, api } from './api'
import { createTranslator, type Locale, type Translate } from './i18n'
import { useResource } from './hooks'
import type { HealthResponse, Project, StudioConfig } from './types'

export type ThemeMode = 'light' | 'dark' | 'system'
export type HealthState = 'ok' | 'degraded' | 'offline' | 'unknown'

const STORAGE_KEYS = {
  locale: 'hymem.locale',
  theme: 'hymem.theme',
  project: 'hymem.projectId',
  workspace: 'hymem.workspaceId',
} as const

function readStorage(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

function writeStorage(key: string, value: string | undefined): void {
  try {
    if (value === undefined || value === '') window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    /* preference persistence is best-effort */
  }
}

export interface AppContextValue {
  t: Translate
  locale: Locale
  setLocale: (locale: Locale) => void
  theme: ThemeMode
  setTheme: (theme: ThemeMode) => void
  projects: Project[]
  projectsError: ApiError | undefined
  projectsLoading: boolean
  reloadProjects: () => void
  projectId: string
  setProjectId: (id: string) => void
  workspaceId: string
  setWorkspaceId: (id: string) => void
  health: HealthResponse | undefined
  healthError: ApiError | undefined
  healthState: HealthState
  reloadHealth: () => void
  capabilities: NonNullable<StudioConfig['capabilities']>
  /** `undefined` when the Host did not report the capture setting. */
  paused: boolean | undefined
  pausePending: boolean
  togglePause: () => Promise<void>
  announce: (message: string) => void
}

const AppContext = createContext<AppContextValue | null>(null)

function detectLocale(): Locale {
  const stored = readStorage(STORAGE_KEYS.locale)
  if (stored === 'en' || stored === 'zh-CN') return stored
  const language = typeof navigator === 'undefined' ? 'en' : navigator.language
  return language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

function detectTheme(): ThemeMode {
  const stored = readStorage(STORAGE_KEYS.theme)
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  return 'system'
}

function healthStateOf(health: HealthResponse | undefined, error: ApiError | undefined): HealthState {
  if (error) return 'offline'
  if (!health) return 'unknown'
  if (health.degraded === true || health.worker?.degraded === true || health.worker?.ok === false) return 'degraded'
  if (health.ok) return 'ok'
  return 'unknown'
}

export function AppProvider({ children }: { children: ReactNode }): ReactNode {
  const [locale, setLocaleState] = useState<Locale>(detectLocale)
  const [theme, setThemeState] = useState<ThemeMode>(detectTheme)
  const [projectId, setProjectIdState] = useState<string>(() => readStorage(STORAGE_KEYS.project) ?? '')
  const [workspaceId, setWorkspaceIdState] = useState<string>(() => readStorage(STORAGE_KEYS.workspace) ?? '')
  const [liveMessage, setLiveMessage] = useState('')
  const [paused, setPaused] = useState<boolean | undefined>(undefined)
  const [pausePending, setPausePending] = useState(false)
  const preferenceApplied = useRef(false)

  const t = useMemo(() => createTranslator(locale), [locale])

  const projectsResource = useResource<Project[]>(signal => api.projects(signal), [])
  const healthResource = useResource<HealthResponse>(signal => api.health(signal), [])
  const configResource = useResource<StudioConfig>(signal => api.studioConfig(signal), [])

  /* Apply the Host locale/theme defaults once, unless the user chose one. */
  useEffect(() => {
    if (preferenceApplied.current) return
    const config = configResource.data
    if (!config) return
    preferenceApplied.current = true
    if (!readStorage(STORAGE_KEYS.locale) && config.locale) setLocaleState(config.locale)
    if (!readStorage(STORAGE_KEYS.theme) && config.theme) setThemeState(config.theme)
  }, [configResource.data])

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.dataset.theme = theme
  }, [theme])

  /* Health polling keeps the header pill honest without busy-looping. */
  const reloadHealth = healthResource.reload
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') reloadHealth()
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [reloadHealth])

  /* Learn the initial capture state from settings, without inventing a value. */
  useEffect(() => {
    let active = true
    api
      .settings()
      .then(settings => {
        if (active) setPaused(settings.settings?.capture ? !settings.settings.capture.enabled : undefined)
      })
      .catch(() => {
        if (active) setPaused(undefined)
      })
    return () => {
      active = false
    }
  }, [])

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    writeStorage(STORAGE_KEYS.locale, next)
  }, [])

  const setTheme = useCallback((next: ThemeMode) => {
    setThemeState(next)
    writeStorage(STORAGE_KEYS.theme, next)
  }, [])

  const setProjectId = useCallback((id: string) => {
    setProjectIdState(id)
    writeStorage(STORAGE_KEYS.project, id)
    setWorkspaceIdState('')
    writeStorage(STORAGE_KEYS.workspace, undefined)
  }, [])

  const setWorkspaceId = useCallback((id: string) => {
    setWorkspaceIdState(id)
    writeStorage(STORAGE_KEYS.workspace, id)
  }, [])

  const announce = useCallback((message: string) => setLiveMessage(message), [])

  const togglePause = useCallback(async () => {
    setPausePending(true)
    try {
      const current = await api.settings()
      const capture = current.settings?.capture
      const nextEnabled = capture ? !capture.enabled : false
      const saved = await api.saveSettings({
        patch: { capture: { enabled: nextEnabled } },
        expectedRevision: current.revision,
      })
      const nextPaused = saved.settings?.capture ? !saved.settings.capture.enabled : !nextEnabled
      setPaused(nextPaused)
      announce(nextPaused ? t('header.paused') : t('header.resume'))
    } catch (error) {
      announce(error instanceof ApiError ? error.message : String(error))
    } finally {
      setPausePending(false)
    }
  }, [announce, t])

  const value: AppContextValue = {
    t,
    locale,
    setLocale,
    theme,
    setTheme,
    projects: projectsResource.data ?? [],
    projectsError: projectsResource.error,
    projectsLoading: projectsResource.status === 'loading',
    reloadProjects: projectsResource.reload,
    projectId,
    setProjectId,
    workspaceId,
    setWorkspaceId,
    health: healthResource.data,
    healthError: healthResource.error,
    healthState: healthStateOf(healthResource.data, healthResource.error),
    reloadHealth,
    capabilities: configResource.data?.capabilities ?? {},
    paused,
    pausePending,
    togglePause,
    announce,
  }

  return (
    <AppContext.Provider value={value}>
      {children}
      <div className="sr-only" role="status" aria-live="polite">
        {liveMessage}
      </div>
    </AppContext.Provider>
  )
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext)
  if (!value) throw new Error('useApp must be used inside AppProvider')
  return value
}