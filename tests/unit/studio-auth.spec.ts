import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HostRuntime } from '../../packages/host-plugin/src/runtime.js'
import { StudioServer } from '../../packages/host-plugin/src/studio.js'

async function createStudio() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hymem-studio-auth-'))
  const server = new StudioServer({
    runtime: { workspace: () => ({ projectId: 'synthetic-project' }) } as unknown as HostRuntime,
    host: '127.0.0.1',
    port: 0,
    token: 'synthetic-studio-token',
    cookieSecret: 'synthetic-cookie-secret',
    studioDir: dataDir,
    frameOrigins: ['http://localhost:43121'],
  })
  const port = await server.start()
  return { dataDir, server, baseUrl: `http://127.0.0.1:${port}` }
}

describe('Studio embedded-session authentication', () => {
  it('sets a partitioned secure cookie and redirects to a token-free URL', async () => {
    const studio = await createStudio()
    try {
      const response = await fetch(`${studio.baseUrl}/studio/?token=synthetic-studio-token`, { redirect: 'manual' })
      const cookie = response.headers.get('set-cookie') ?? ''
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe('/studio/')
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toMatch(/SameSite=None/i)
      expect(cookie).toMatch(/Secure/i)
      expect(cookie).toMatch(/Partitioned/i)
      expect(cookie).not.toContain('synthetic-studio-token')
    } finally {
      await studio.server.close()
      rmSync(studio.dataDir, { recursive: true, force: true })
    }
  })

  it('only returns the CSRF token from the authenticated no-store session endpoint', async () => {
    const studio = await createStudio()
    try {
      const anonymous = await fetch(`${studio.baseUrl}/api/session`)
      expect(anonymous.status).toBe(401)

      const login = await fetch(`${studio.baseUrl}/studio/?token=synthetic-studio-token`, { redirect: 'manual' })
      const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]
      expect(cookie).toBeTruthy()
      const session = await fetch(`${studio.baseUrl}/api/session`, { headers: { cookie: cookie! } })
      expect(session.status).toBe(200)
      expect(session.headers.get('cache-control')).toBe('no-store')
      expect(await session.json()).toEqual({ csrf: 'synthetic-studio-token' })
    } finally {
      await studio.server.close()
      rmSync(studio.dataDir, { recursive: true, force: true })
    }
  })

  it('keeps the existing CSRF guard on authenticated mutation requests', async () => {
    const studio = await createStudio()
    try {
      const login = await fetch(`${studio.baseUrl}/studio/?token=synthetic-studio-token`, { redirect: 'manual' })
      const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]
      expect(cookie).toBeTruthy()
      for (const csrf of [undefined, 'wrong-synthetic-csrf']) {
        const response = await fetch(`${studio.baseUrl}/api/settings`, {
          method: 'PUT',
          headers: {
            cookie: cookie!,
            'content-type': 'application/json',
            ...(csrf ? { 'x-hymemory-csrf': csrf } : {}),
          },
          body: JSON.stringify({ expectedRevision: 1, patch: { capture: { enabled: false } } }),
        })
        expect(response.status).toBe(403)
      }
    } finally {
      await studio.server.close()
      rmSync(studio.dataDir, { recursive: true, force: true })
    }
  })
})
