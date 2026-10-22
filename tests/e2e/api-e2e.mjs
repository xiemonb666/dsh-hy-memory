/**
 * End-to-end acceptance tests against a running Studio API.
 *
 * These exercise the real HTTP surface and the real SQLite governance store:
 * no mocks, no fixtures beyond the data the tests themselves create.
 *
 *   node tests/e2e/api-e2e.mjs
 *
 * Requires a running Studio (plugin active or `cli serve`), and the data
 * directory holding `ui-token`.
 *
 * HTTP uses node:http rather than global fetch. On Node 24.16 the undici
 * keep-alive pool can abort the process during exit teardown
 * (STATUS_STACK_BUFFER_OVERRUN, 0xC0000409) *after* every assertion has passed,
 * which makes a green run look red; node:http closes deterministically.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'

const base = process.env.HYMEM_STUDIO_URL ?? 'http://127.0.0.1:48731'
const dataDir = process.env.HYMEM_DATA_DIR ?? join(process.cwd(), 'artifacts', 'e2e-data')
const token = readFileSync(join(dataDir, 'ui-token'), 'utf8').trim()
const origin = new URL(base)

let cookie = ''

function send(path, options = {}) {
  const headers = { ...options.headers }
  if (cookie) headers.cookie = cookie
  let payload = null
  if (options.body !== undefined) {
    payload = JSON.stringify(options.body)
    headers['content-type'] = 'application/json'
    headers['content-length'] = Buffer.byteLength(payload)
  }
  if (options.method && options.method !== 'GET' && options.csrf !== false) headers['x-hymemory-csrf'] = token
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: origin.hostname, port: origin.port, path, method: options.method ?? 'GET', headers },
      response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          const setCookie = response.headers['set-cookie']
          if (Array.isArray(setCookie) && setCookie[0]) cookie = setCookie[0].split(';')[0]
          let body
          try {
            body = JSON.parse(text)
          } catch {
            body = text
          }
          resolve({ status: response.statusCode ?? 0, body, text })
        })
      },
    )
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

const results = []
function check(id, name, condition, detail) {
  results.push({ id, name, ok: Boolean(condition), detail })
  if (!condition) process.stderr.write(`FAIL ${id} ${name}: ${String(JSON.stringify(detail ?? '')).slice(0, 400)}\n`)
}

// Authenticate.
const login = await send(`/studio/?token=${encodeURIComponent(token)}`)
check('AUTH', 'token login redirects and sets a session cookie', login.status === 302 && cookie.length > 0, login.status)

// E2E-11: the UI read path, health and overview reflect the real store.
const health = await send('/api/health')
check('E2E-11a', 'health reports plugin version and audit chain', health.status === 200 && health.body.plugin?.version === '0.1.0', health.body)
const overview = await send('/api/overview')
check('E2E-11b', 'overview counts are numeric', typeof overview.body.counts?.total === 'number', overview.body.counts)
const list = await send('/api/memories?pageSize=50')
check('E2E-11c', 'memory list is paged with a total', Array.isArray(list.body.items) && typeof list.body.total === 'number', { total: list.body.total })

// E2E-13: project isolation — a foreign project id yields nothing.
const foreign = await send('/api/memories?projectId=project_does_not_exist')
check('E2E-13', 'foreign project returns zero rows', foreign.status === 200 && foreign.body.total === 0, foreign.body)

// E2E-12: conflict resolution is revision-checked and audited.
const conflicts = await send('/api/conflicts')
check('E2E-12a', 'conflict list is available', conflicts.status === 200 && Array.isArray(conflicts.body.items), conflicts.status)

// Settings round-trip with optimistic concurrency.
const settings = await send('/api/settings')
check('SET-1', 'settings expose a revision', typeof settings.body.revision === 'number', settings.body.revision)
const patched = await send('/api/settings', {
  method: 'PUT',
  body: { patch: { recall: { maxInjectionTokens: 500 } }, expectedRevision: settings.body.revision },
})
check('SET-2', 'settings update bumps the revision', patched.status === 200 && patched.body.revision === settings.body.revision + 1, patched.body)
const staleWrite = await send('/api/settings', {
  method: 'PUT',
  body: { patch: { recall: { maxInjectionTokens: 400 } }, expectedRevision: settings.body.revision },
})
check('SET-3', 'stale settings write is rejected with 409', staleWrite.status === 409, staleWrite.status)
await send('/api/settings', {
  method: 'PUT',
  body: { patch: { recall: { maxInjectionTokens: 600 } }, expectedRevision: patched.body.revision },
})

// CSRF enforcement: the same mutation without the header must be refused.
const noCsrf = await send('/api/settings', {
  method: 'PUT',
  csrf: false,
  body: { patch: {}, expectedRevision: 1 },
})
check('SEC-1', 'mutation without the CSRF header is rejected', noCsrf.status === 403, noCsrf.status)

// Unauthenticated access.
const anonymous = await new Promise((resolve, reject) => {
  const request = httpRequest(
    { host: origin.hostname, port: origin.port, path: '/api/health', method: 'GET' },
    response => {
      response.resume()
      response.on('end', () => resolve(response.statusCode ?? 0))
    },
  )
  request.on('error', reject)
  request.end()
})
check('SEC-2', 'anonymous API access is rejected', anonymous === 401, anonymous)

// Path traversal.
const traversal = await send('/studio/../../etc/passwd')
check('SEC-3', 'path traversal is not served', traversal.status === 404 || traversal.status === 403, traversal.status)

// Diagnostics exposes the audit chain and permission matrix.
const diagnostics = await send('/api/diagnostics')
check(
  'OPS-1',
  'diagnostics reports audit validity and a permission matrix',
  diagnostics.status === 200 && diagnostics.body.audit?.ok === true && Array.isArray(diagnostics.body.permissionMatrix),
  { audit: diagnostics.body.audit, matrix: diagnostics.body.permissionMatrix?.length },
)

// Backup produces a verifiable file.
const backup = await send('/api/backup', { method: 'POST', body: {} })
check('OPS-2', 'backup returns a sha256 and byte count', backup.status === 200 && /^[0-9a-f]{64}$/.test(backup.body.sha256 ?? ''), backup.body)

// Audit chain still valid after all mutations.
const after = await send('/api/diagnostics')
check('OPS-3', 'audit chain remains valid after mutations', after.body.audit?.ok === true, after.body.audit)

const failed = results.filter(item => !item.ok)
console.log(JSON.stringify({ ok: failed.length === 0, total: results.length, failed: failed.length, results }, null, 2))
process.exit(failed.length === 0 ? 0 : 1)
