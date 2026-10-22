import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeConfig } from '../../packages/host-plugin/src/config.js'
import type { HostRuntime } from '../../packages/host-plugin/src/runtime.js'
import { StudioServer } from '../../packages/host-plugin/src/studio.js'

async function studioPolicy(origins?: string[]) {
  const dataDir = mkdtempSync(join(tmpdir(), 'hymem-desktop-csp-'))
  const config = normalizeConfig({ dataDir, ...(origins ? { ui: { allowedFrameOrigins: origins } } : {}) })
  const server = new StudioServer({
    runtime: {} as HostRuntime,
    host: '127.0.0.1', port: 0, token: 'synthetic-ui-token', cookieSecret: 'synthetic-cookie-secret',
    studioDir: dataDir, frameOrigins: config.ui.allowedFrameOrigins,
  })
  try {
    const port = await server.start()
    const response = await fetch(`http://127.0.0.1:${port}/studio/`)
    return { status: response.status, csp: response.headers.get('content-security-policy') ?? '' }
  } finally {
    await server.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
}

describe('Studio embedding policy', () => {
  it('admits the official Desktop origin while keeping authentication and a closed ancestor list', async () => {
    const response = await studioPolicy()
    expect(response.status).toBe(401)
    const ancestors = response.csp.split(';')[0]?.split(/\s+/).slice(1)
    expect(ancestors).toContain('dsh-app://app')
    expect(ancestors).not.toContain('*')
    expect(ancestors).not.toContain('null')
    expect(ancestors).not.toContain('https://example.com')
  })

  it('preserves an explicitly restricted embedding policy', async () => {
    const response = await studioPolicy(['http://127.0.0.1:3333'])
    expect(response.status).toBe(401)
    expect(response.csp.split(';')[0]).toBe('frame-ancestors http://127.0.0.1:3333')
  })
})
