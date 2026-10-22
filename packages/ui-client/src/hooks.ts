/**
 * Small React building blocks shared by every page: hash routing, a race-safe
 * resource hook, mutation state, debouncing and focus management
 * (focus trap + restore for dialogs and drawers).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { ApiError } from './api'

/* ------------------------------------------------------------------ */
/* Hash routing                                                        */
/* ------------------------------------------------------------------ */

export const ROUTE_NAMES = [
  'overview',
  'memories',
  'evidence',
  'conflicts',
  'agents',
  'capture',
  'usage',
  'settings',
  'diagnostics',
] as const

export type RouteName = (typeof ROUTE_NAMES)[number]

export interface Route {
  name: RouteName
  params: URLSearchParams
  path: string
}

const DEFAULT_ROUTE: RouteName = 'overview'

function isRouteName(value: string): value is RouteName {
  return (ROUTE_NAMES as readonly string[]).includes(value)
}

export function parseHash(hash: string): Route {
  const cleaned = hash.replace(/^#\/?/, '')
  const [pathPart = '', query = ''] = cleaned.split('?')
  const name = isRouteName(pathPart) ? pathPart : DEFAULT_ROUTE
  return { name, params: new URLSearchParams(query), path: pathPart }
}

export function hrefFor(name: RouteName, params?: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const query = search.toString()
  return `#/${name}${query ? `?${query}` : ''}`
}

export function navigate(name: RouteName, params?: Record<string, string | number | undefined>): void {
  window.location.hash = hrefFor(name, params)
}

export function useHashRoute(): Route {
  const [hash, setHash] = useState(() => window.location.hash)

  useEffect(() => {
    const onChange = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onChange)
    if (!window.location.hash) window.location.replace(`#/${DEFAULT_ROUTE}`)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  return parseHash(hash)
}

/* ------------------------------------------------------------------ */
/* Resources                                                           */
/* ------------------------------------------------------------------ */

export type ResourceStatus = 'loading' | 'success' | 'error'

export interface Resource<T> {
  status: ResourceStatus
  data: T | undefined
  error: ApiError | undefined
  /** True while a reload keeps the previous data on screen. */
  refreshing: boolean
  reload: () => void
  setData: (data: T) => void
}

/**
 * Run an abortable loader whenever `deps` change. Late responses from an older
 * request are discarded, so switching filters never shows stale rows.
 */
export function useResource<T>(loader: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[]): Resource<T> {
  const [state, setState] = useState<{ status: ResourceStatus; data: T | undefined; error: ApiError | undefined }>({
    status: 'loading',
    data: undefined,
    error: undefined,
  })
  const [nonce, setNonce] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const loaderRef = useRef(loader)
  loaderRef.current = loader

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setState(previous => ({
      status: previous.data === undefined ? 'loading' : previous.status,
      data: previous.data,
      error: undefined,
    }))
    setRefreshing(true)

    loaderRef
      .current(controller.signal)
      .then(data => {
        if (!active) return
        setState({ status: 'success', data, error: undefined })
      })
      .catch((error: unknown) => {
        if (!active) return
        if (error instanceof ApiError && error.kind === 'aborted') return
        setState(previous => ({
          status: 'error',
          data: previous.data,
          error: error instanceof ApiError ? error : new ApiError({ message: String(error), kind: 'offline' }),
        }))
      })
      .finally(() => {
        if (active) setRefreshing(false)
      })

    return () => {
      active = false
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  const reload = useCallback(() => setNonce(value => value + 1), [])
  const setData = useCallback((data: T) => setState({ status: 'success', data, error: undefined }), [])

  return { ...state, refreshing, reload, setData }
}

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

export interface AsyncAction {
  pending: boolean
  error: ApiError | undefined
  run: (task: () => Promise<void>) => Promise<boolean>
  clearError: () => void
}

export function useAsyncAction(): AsyncAction {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const run = useCallback(async (task: () => Promise<void>) => {
    setPending(true)
    setError(undefined)
    try {
      await task()
      return true
    } catch (caught) {
      if (mounted.current) {
        setError(caught instanceof ApiError ? caught : new ApiError({ message: String(caught), kind: 'offline' }))
      }
      return false
    } finally {
      if (mounted.current) setPending(false)
    }
  }, [])

  return { pending, error, run, clearError: () => setError(undefined) }
}

/* ------------------------------------------------------------------ */
/* Misc hooks                                                          */
/* ------------------------------------------------------------------ */

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false))
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const list = window.matchMedia(query)
    const onChange = () => setMatches(list.matches)
    onChange()
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/**
 * Trap Tab inside `ref` while `active`, close on Escape, and restore focus to
 * the element that was focused before activation.
 *
 * Traps are stacked: when a modal opens above a drawer, only the newest trap
 * reacts to Tab/Escape, and the surface underneath is hidden from assistive
 * technology for as long as it is covered.
 */
const trapStack: symbol[] = []

export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, onClose?: () => void): void {
  useEffect(() => {
    if (!active) return
    const node = ref.current
    if (!node) return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const token = Symbol('focus-trap')
    trapStack.push(token)

    const isTopmost = () => trapStack[trapStack.length - 1] === token

    const focusables = () =>
      Array.from(
        node.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(element => element.offsetParent !== null || element === document.activeElement)

    const first = focusables()[0]
    ;(first ?? node).focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopmost()) return
      if (event.key === 'Escape' && onClose) {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) {
        event.preventDefault()
        return
      }
      const firstItem = items[0]
      const lastItem = items[items.length - 1]
      if (!firstItem || !lastItem) return
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault()
        lastItem.focus()
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault()
        firstItem.focus()
      }
    }

    node.addEventListener('keydown', onKeyDown)
    return () => {
      node.removeEventListener('keydown', onKeyDown)
      const index = trapStack.indexOf(token)
      if (index >= 0) trapStack.splice(index, 1)
      previouslyFocused?.focus()
    }
  }, [active, onClose, ref])
}