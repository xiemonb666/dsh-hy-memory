/**
 * Studio entry point. Mounts the SPA into `#root`; the Host serves this bundle
 * from `/studio/` and injects `window.__HYMEM_CONFIG__` (apiBase + CSRF token).
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { AppProvider } from './store'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('HyMemory Studio: #root container is missing')

createRoot(container).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>,
)