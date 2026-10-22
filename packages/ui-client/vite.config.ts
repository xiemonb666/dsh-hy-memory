import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

/**
 * Studio SPA build.
 *
 * The Host plugin serves the bundle at `/studio/` (contract §2), so production
 * assets are emitted with that base. During `vite dev` the SPA runs at `/` and
 * `/api/*` is proxied to the loopback Host API; point `VITE_API_BASE` at another
 * origin when the Host listens elsewhere.
 *
 * `root` is pinned to this package so the build works from the repository root
 * as well as from the package directory.
 *
 * `VITE_USE_FIXTURES=1` enables the synthetic fixture module. It is compiled to a
 * literal `'0'` in every other build, so `src/dev-mock.ts` is dead-code
 * eliminated and can never be reached by a normal production bundle.
 */
const root = fileURLToPath(new URL('.', import.meta.url))
const apiTarget = process.env.VITE_API_BASE ?? 'http://127.0.0.1:48731'
const useFixtures = process.env.VITE_USE_FIXTURES === '1'

export default defineConfig(({ command }) => ({
  root,
  base: command === 'build' ? '/studio/' : '/',
  plugins: [react()],
  define: {
    'import.meta.env.VITE_USE_FIXTURES': JSON.stringify(useFixtures ? '1' : '0'),
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
    },
  },
}))
