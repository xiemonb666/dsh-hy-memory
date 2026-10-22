/**
 * HyMemory Studio browser half.
 *
 * Registers a sidebar entry plus a `main` keyed panel that hosts the Studio SPA
 * in an iframe pointed at the plugin's authenticated loopback server. The
 * iframe URL carries a single-use token; the server exchanges it for an
 * HttpOnly SameSite=Strict cookie and then redirects to the token-free path.
 *
 * The operator CLI substitutes the token and port in a private bundle copy at
 * install time; no secret is fetched from the page at runtime.
 */
window.__ModuleLoader__.load({
  id: 'dsh-hy-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const PANEL_ID = 'hy-memory-studio'
    const NS = 'hyMemoryStudio'
    const UI_PORT = '__HYMEM_UI_PORT__'
    const UI_TOKEN = '__HYMEM_UI_TOKEN__'
    const BASE = `http://127.0.0.1:${UI_PORT}`

    const en = {
      panel: 'HyMemory Studio',
      tab: 'Memory',
      title: 'HyMemory Studio',
      loading: 'Loading Studio…',
      openExternal: 'Open in a new tab',
      offline: 'The Studio server is not reachable. Start the HyMemory plugin and reload.',
      reload: 'Reload',
      settingsSummary: 'Open HyMemory settings in Studio.',
    }
    const zh = {
      panel: 'HyMemory 记忆台',
      tab: '记忆台',
      title: 'HyMemory 记忆台',
      loading: '正在加载记忆台…',
      openExternal: '在新标签页打开',
      offline: '无法连接记忆台服务。请启用 HyMemory 插件后重试。',
      reload: '重新加载',
      settingsSummary: '在记忆台中打开 HyMemory 设置。',
    }

    function PanelIcon({ size }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
        h('rect', { x: 2, y: 2, width: 20, height: 20, rx: 5, fill: 'currentColor', opacity: 0.16 }),
        h('path', {
          d: 'M6 17V7h2.2l3.8 4.6L15.8 7H18v10h-2.1v-6.4L12 15l-3.9-4.4V17z',
          fill: 'currentColor',
        }),
      )
    }

    /**
     * Full-area frame used by both entry points.
     *
     * The Studio is a complete application with its own navigation, so it is
     * rendered at the full size of whichever surface hosts it. The iframe keeps
     * the Studio's authenticated cookie exchange (single-use token → HttpOnly
     * SameSite=Strict cookie) out of the host page's origin.
     */
    function StudioFrame({ t, route = '' }) {
      const [state, setState] = React.useState({ kind: 'loading' })
      const src = `${BASE}/studio/?token=${encodeURIComponent(UI_TOKEN)}${route}`

      React.useEffect(() => {
        // The iframe performs its own authenticated load; probing /api/health
        // from the host page would be blocked by the host CSP and would also
        // race the iframe's cookie exchange. Only a silent iframe (no load
        // event within the grace period) is treated as offline.
        const timer = setTimeout(() => setState(previous => (previous.kind === 'ready' ? previous : { kind: 'offline' })), 12000)
        return () => clearTimeout(timer)
      }, [])

      const style = {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: 'var(--dsw-alias-bg-base, #fff)',
        color: 'var(--dsw-alias-label-primary, #111)',
      }

      if (state.kind === 'offline') {
        return h(
          'div',
          { style: { ...style, padding: 24, gap: 12 } },
          h('h2', { style: { margin: 0, fontSize: 18 } }, t('title')),
          h('p', { style: { margin: 0, maxWidth: 560, lineHeight: 1.5 } }, t('offline')),
          h('a', { href: `${BASE}/studio/`, target: '_blank', rel: 'noreferrer', style: { color: 'inherit' } }, t('openExternal')),
        )
      }

      return h(
        'div',
        { style: { ...style, position: 'relative' } },
        state.kind === 'loading'
          ? h(
              'div',
              { style: { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 13, opacity: 0.7 } },
              t('loading'),
            )
          : null,
        h('iframe', {
          src,
          title: t('title'),
          onLoad: () => setState({ kind: 'ready' }),
          style: { width: '100%', height: '100%', border: 0, display: 'block', background: 'transparent' },
          allow: 'clipboard-write',
        }),
      )
    }

    /** Conversation View tab body: the Studio fills the Conversation area. */
    function StudioView({ t }) {
      return h(StudioFrame, { t })
    }

    function StudioPanel({ t }) {
      const style = {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: 'var(--dsw-alias-bg-base, #fff)',
        color: 'var(--dsw-alias-label-primary, #111)',
      }
      const header = {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '10px 16px',
        borderBottom: '0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))',
        fontSize: 13,
      }
      const body = { flex: 1, minHeight: 0, position: 'relative' }

      return h(
        'div',
        { style },
        h(
          'div',
          { style: header },
          h('strong', null, t('title')),
          h(
            'a',
            { href: `${BASE}/studio/`, target: '_blank', rel: 'noreferrer', style: { color: 'inherit', opacity: 0.75 } },
            t('openExternal'),
          ),
        ),
        h('div', { style: body }, h(StudioFrame, { t })),
      )
    }

    function BundleSettings({ t, view }) {
      if (view === 'summary') return h('p', null, t('settingsSummary'))
      return h(StudioFrame, { t, route: '#/settings' })
    }

    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-hy-memory: dictionaries')
        const t = ctx.locale.bind(NS)
        // Primary entry: a View tab beside the built-in Chat and Trajectory tabs
        // (conversation.view is the Conversation tab strip; its shipped occupants
        // are `chat` at order 0 and `trajectory` at order 10). This is where a
        // user looks for a per-conversation tool, so it is the main entry point.
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            {
              name: 'conversation.view',
              id: PANEL_ID,
              order: 20,
              label: () => t('tab'),
              locale: NS,
            },
            StudioView,
          ),
        )
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            {
              name: 'plugins.bundle.config',
              key: 'dsh-hy-memory',
              locale: NS,
            },
            BundleSettings,
          ),
        )
        // Secondary entry: the global panel list, so the Studio is reachable
        // without an open conversation. The sidebar button addresses the `main`
        // panel below by this same id.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 40,
              label: () => t('panel'),
              locale: NS,
            },
            PanelIcon,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: NS,
            },
            StudioPanel,
          ),
        )
        ctx.effect(() => {
          const onOpen = () => ctx.layout.selectPanel(PANEL_ID)
          globalThis.addEventListener('hymem:open-studio', onOpen)
          return () => globalThis.removeEventListener('hymem:open-studio', onOpen)
        }, 'dsh-hy-memory: open hook')
      },
    }
  },
})
