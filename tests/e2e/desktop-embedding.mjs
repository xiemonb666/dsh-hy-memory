import assert from 'node:assert/strict'
import { accessSync, constants, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '../..')
const validationRoot = path.join(root, 'artifacts/validation-20261021')
const bundleDir = path.join(validationRoot, 'bundle-desktop-auth-test-20261022')
const runDir = mkdtempSync(path.join(validationRoot, 'desktop-auth-e2e-'))
const dbPath = path.join(runDir, 'data', 'hymemory.db')
const syntheticToken = 'desktop-auth-e2e-synthetic-token'
const cookieSecret = 'desktop-auth-e2e-synthetic-cookie-secret'
const projectId = 'desktop-auth-e2e-project'
const workspaceId = 'desktop-auth-e2e-workspace'
const events = []
const result = {
  probe: 'real Studio UI in a synthetic localhost-parent to 127.0.0.1 iframe; real GovernanceStore SQLite; fake engine runtime; no DSH or model calls',
  browser: {},
  checks: {
    cookieSecure: false,
    cookieHttpOnly: false,
    cookieSameSiteNone: false,
    cookiePartitioned: false,
    tokenFreeRedirect: false,
    freshSessionStorageHasNoCsrf: false,
    csrfBootstrapNoStore: false,
    csrfHeaderOnMutation: false,
    mutationSucceeded: false,
    settingReloadedFromDatabase: false,
    settingSurvivedStoreReopen: false,
    bootstrapFailureReported: false,
    bootstrapFailureBlocksWrite: false,
    noCrossOriginRequests: true,
  },
  cleanup: {},
}

let parentPort
let studioPort
let parentStarted = false
let studioStarted = false
let browserServer
let browser
let context
let store
let StudioServerClass
let studioServer
let GovernanceStoreClass
let stage = 'setup'
let failure

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server.address().port)
    })
  })
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections?.()
  })
}

function portRefuses(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const finish = value => { socket.destroy(); resolve(value) }
    socket.setTimeout(800, () => finish(false))
    socket.once('connect', () => finish(false))
    socket.once('error', error => finish(error.code === 'ECONNREFUSED'))
  })
}

function recordResponse(response) {
  const request = response.request()
  const requestUrl = new URL(request.url())
  if (requestUrl.hostname !== '127.0.0.1' || requestUrl.port !== String(studioPort)) {
    if (requestUrl.hostname !== 'localhost' || requestUrl.port !== String(parentPort)) result.checks.noCrossOriginRequests = false
    return
  }
  const route = requestUrl.pathname
  const method = request.method()
  const headers = request.headers()
  const headersOut = response.headers()
  const entry = {
    method,
    route,
    status: response.status(),
    hasCsrfHeader: Boolean(headers['x-hymemory-csrf']),
    cacheControl: headersOut['cache-control'] ?? null,
  }
  events.push(entry)
  if (method === 'GET' && route === '/api/session') {
    result.checks.csrfBootstrapNoStore ||= entry.status === 200 && entry.cacheControl === 'no-store'
  }
  if (method === 'PUT' && route === '/api/settings') {
    result.checks.csrfHeaderOnMutation = entry.hasCsrfHeader
    result.checks.mutationSucceeded = entry.status === 200
  }
  if (route === '/studio/' && method === 'GET' && requestUrl.searchParams.has('token')) {
    const location = headersOut.location ?? ''
    result.checks.tokenFreeRedirect = response.status() === 302 && location === '/studio/' && !location.includes('token')
  }
}

const parent = createServer((_request, response) => {
  const studioUrl = `http://127.0.0.1:${studioPort}/studio/?token=${encodeURIComponent(syntheticToken)}`
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end(`<!doctype html><html><body><iframe id="studio" title="HyMemory Studio" style="width:1440px;height:900px;border:0" src="${studioUrl}"></iframe></body></html>`)
})

async function buildGovernanceBridge() {
  const bridgePath = path.join(runDir, 'governance-store.mjs')
  await build({
    entryPoints: [path.join(root, 'packages/governance/src/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['node:*'],
    outfile: bridgePath,
    logLevel: 'silent',
  })
  const module = await import(`${pathToFileURL(bridgePath).href}?run=${Date.now()}`)
  return module.GovernanceStore
}

try {
  assert.ok(path.isAbsolute(bundleDir), 'test bundle path must be absolute')
  accessSync(path.join(bundleDir, 'studio-api.js'), constants.R_OK)
  accessSync(path.join(bundleDir, 'studio', 'index.html'), constants.R_OK)

  stage = 'load actual store and Studio server'
  GovernanceStoreClass = await buildGovernanceBridge()
  store = new GovernanceStoreClass(dbPath)
  store.ensureOwner()
  store.ensureWorkspace({
    id: workspaceId,
    projectId,
    repoFingerprint: 'desktop-auth-e2e-fingerprint',
    rootAlias: '<temporary-workspace>',
  })
  assert.equal(store.getSettings().settings.capture.enabled, true, 'fixture starts with capture enabled')

  const apiModule = await import(pathToFileURL(path.join(bundleDir, 'studio-api.js')).href)
  StudioServerClass = apiModule.StudioServer
  const workspace = {
    projectId,
    workspaceId,
    repoFingerprint: 'desktop-auth-e2e-fingerprint',
    rootAlias: '<temporary-workspace>',
  }
  const runtime = {
    config: { dataDir: path.dirname(dbPath) },
    store,
    recall: { settings: () => ({ mode: 'tool-only' }), invalidate() {} },
    workspace: () => workspace,
    engineHealth: async () => ({ ok: true, degraded: false, reason: null, engine: 'mock', version: 'synthetic' }),
  }
  const studioOptions = {
    runtime,
    host: '127.0.0.1',
    port: 0,
    token: syntheticToken,
    cookieSecret,
    studioDir: path.join(bundleDir, 'studio'),
    frameOrigins: [],
  }

  stage = 'start parent and isolated Chromium'
  parentPort = await listen(parent)
  parentStarted = true
  const parentOrigin = `http://localhost:${parentPort}`
  studioOptions.frameOrigins = [parentOrigin]
  studioServer = new StudioServerClass(studioOptions)
  studioPort = await studioServer.start()
  studioStarted = true
  const studioOrigin = `http://127.0.0.1:${studioPort}`
  browserServer = await chromium.launchServer({
    headless: true,
    artifactsDir: path.join(runDir, 'browser-artifacts'),
    args: [
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--no-first-run',
      '--host-resolver-rules=MAP localhost 127.0.0.1',
    ],
  })
  const browserProcess = browserServer.process()
  result.browser = { engine: 'Chromium', ownedPid: browserProcess?.pid ?? null }
  browser = await chromium.connect(browserServer.wsEndpoint())
  result.browser.version = browser.version()
  context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } })
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    const allowed = (url.hostname === 'localhost' && url.port === String(parentPort))
      || (url.hostname === '127.0.0.1' && url.port === String(studioPort))
  
    if (allowed) await route.continue()
    else {
      result.checks.noCrossOriginRequests = false
      await route.abort('blockedbyclient')
    }
  })
  const page = await context.newPage()
  page.on('response', response => { recordResponse(response) })

  stage = 'authenticate and render the fresh iframe'
  await page.goto(parentOrigin, { waitUntil: 'domcontentloaded', timeout: 15000 })
  const studioFrame = () => page.frames().find(frame => frame.url().startsWith(`${studioOrigin}/studio/`))
  let frame
  const frameDeadline = Date.now() + 15000
  while (!(frame = studioFrame()) && Date.now() < frameDeadline) await new Promise(resolve => setTimeout(resolve, 25))
  assert.ok(frame, 'Studio iframe reached the token-free route')
  stage = 'inspect loaded Studio shell navigation'
  result.uiBoot = await frame.locator('#root').evaluate(rootNode => ({
    appShellPresent: Boolean(rootNode.querySelector('.app')),
    navTargets: [...rootNode.querySelectorAll('a.nav__link')].map(link => link.getAttribute('href')),
  }))
  assert.ok(result.uiBoot.appShellPresent, 'built Studio shell rendered')
  if (await frame.locator('a[href="#/settings"]').count() === 0 && await frame.locator('button.icon-btn').count() > 0) {
    await frame.locator('button.icon-btn').first().click()
  }
  await frame.locator('a[href="#/settings"]').waitFor({ state: 'visible', timeout: 15000 })
  assert.equal(new URL(frame.url()).search, '', 'post-login iframe URL is token-free')
  result.checks.tokenFreeRedirect ||= new URL(frame.url()).search === ''
  result.checks.freshSessionStorageHasNoCsrf = await frame.evaluate(() => sessionStorage.getItem('hymem.csrf') === null)
  const cookie = (await context.cookies(studioOrigin)).find(item => item.name === 'hymem_session')
  result.checks.cookieSecure = Boolean(cookie?.secure)
  result.checks.cookieHttpOnly = Boolean(cookie?.httpOnly)
  result.checks.cookieSameSiteNone = cookie?.sameSite === 'None'
  result.checks.cookiePartitioned = Boolean(cookie && 'partitionKey' in cookie && cookie.partitionKey)
  assert.ok(cookie, 'authenticated session cookie was stored')

  stage = 'save one real settings change through the UI'
  stage = 'navigate to settings'
  await frame.locator('a[href="#/settings"]').click()
  stage = 'select capture settings'
  await frame.locator('#settings-tab-capture').click()
  stage = 'read current capture setting'
  const captureEnabled = frame.locator('#setting-capture-enabled')
  await captureEnabled.waitFor({ state: 'visible', timeout: 10000 })
  result.uiControls = await frame.evaluate(() => ({
    viewportWidth: window.innerWidth,
    settingsLinks: document.querySelectorAll('a[href="#/settings"]').length,
    captureTab: Boolean(document.querySelector('#settings-tab-capture')),
    captureCheckbox: Boolean(document.querySelector('#setting-capture-enabled')),
    saveButtons: [...document.querySelectorAll('button')].filter(button => /保存修改|Save changes/.test(button.textContent ?? '')).length,
  }))
  assert.equal(await captureEnabled.isChecked(), true, 'initial capture setting is enabled')
  stage = 'change capture setting'
  await captureEnabled.uncheck()
  const saveResponse = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.origin === studioOrigin && url.pathname === '/api/settings' && response.request().method() === 'PUT'
  }, { timeout: 10000 })
  stage = 'click the Studio Save action'
  await frame.getByRole('button', { name: /保存修改|Save changes/ }).click()
  stage = 'wait for settings mutation response'
  const savedResponse = await saveResponse
  assert.equal(savedResponse.status(), 200, 'UI settings mutation should pass authenticated CSRF guard')
  assert.equal(store.getSettings().settings.capture.enabled, false, 'UI mutation changed the live SQLite store')
  result.checks.mutationSucceeded = true

  stage = 'reload and verify persistent SQLite value'
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 })
  const reloadedFrameDeadline = Date.now() + 15000
  while (!(frame = studioFrame()) && Date.now() < reloadedFrameDeadline) await new Promise(resolve => setTimeout(resolve, 25))
  assert.ok(frame, 'iframe returned after parent reload')
  await frame.locator('a[href="#/settings"]').waitFor({ state: 'visible', timeout: 15000 })
  await frame.locator('a[href="#/settings"]').click()
  await frame.locator('#settings-tab-capture').click()
  assert.equal(await frame.locator('#setting-capture-enabled').isChecked(), false, 'reloaded UI reads the disabled setting')
  result.checks.settingReloadedFromDatabase = true
  store.close()
  store = null
  store = new GovernanceStoreClass(dbPath)
  runtime.store = store
  assert.equal(store.getSettings().settings.capture.enabled, false, 'setting remains after closing and reopening SQLite')
  result.checks.settingSurvivedStoreReopen = true

  stage = 'verify failed CSRF bootstrap blocks the UI mutation'
  await context.close()
  context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } })
  await context.route('**/*', async route => {
    const requestUrl = new URL(route.request().url())
    const allowedOrigin = (requestUrl.hostname === 'localhost' && requestUrl.port === String(parentPort))
      || (requestUrl.hostname === '127.0.0.1' && requestUrl.port === String(studioPort))
    if (!allowedOrigin) {
      result.checks.noCrossOriginRequests = false
      await route.abort('blockedbyclient')
      return
    }
    if (requestUrl.origin === studioOrigin && requestUrl.pathname === '/api/session' && route.request().method() === 'GET') {
      await route.fulfill({
        status: 503,
        headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ error: { code: 'E_BACKEND_UNAVAILABLE', message: 'synthetic bootstrap unavailable' } }),
      })
      return
    }
    await route.continue()
  })
  const failedPage = await context.newPage()
  failedPage.on('response', response => { recordResponse(response) })
  await failedPage.goto(parentOrigin, { waitUntil: 'domcontentloaded', timeout: 15000 })
  const failedFrameDeadline = Date.now() + 15000
  let failedFrame
  while (!(failedFrame = failedPage.frames().find(item => item.url().startsWith(`${studioOrigin}/studio/`))) && Date.now() < failedFrameDeadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.ok(failedFrame, 'fresh failure-test iframe reached Studio')
  await failedFrame.locator('a[href="#/settings"]').waitFor({ state: 'visible', timeout: 15000 })
  await failedFrame.locator('a[href="#/settings"]').click()
  await failedFrame.locator('#settings-tab-capture').click()
  const retryCapture = failedFrame.locator('#setting-capture-enabled')
  await retryCapture.waitFor({ state: 'visible', timeout: 10000 })
  assert.equal(await retryCapture.isChecked(), false, 'the successful UI save persisted before failure injection')
  await retryCapture.check()
  const putsBeforeFailedBootstrap = events.filter(item => item.method === 'PUT' && item.route === '/api/settings').length
  await failedFrame.getByRole('button', { name: /保存修改|Save changes/ }).click()
  await failedFrame.getByRole('alert').waitFor({ state: 'visible', timeout: 5000 })
  result.checks.bootstrapFailureReported = true
  await new Promise(resolve => setTimeout(resolve, 100))
  const sessionFailureCount = events.filter(item => item.method === 'GET' && item.route === '/api/session' && item.status === 503).length
  const putsAfterFailedBootstrap = events.filter(item => item.method === 'PUT' && item.route === '/api/settings').length
  result.checks.bootstrapFailureBlocksWrite = sessionFailureCount === 1
    && putsAfterFailedBootstrap === putsBeforeFailedBootstrap
    && store.getSettings().settings.capture.enabled === false
} catch (error) {
  failure = { stage, name: error?.name ?? 'Error' }
} finally {
  if (context) await context.close().catch(() => {})
  if (browser) await browser.close().catch(() => {})
  let browserExit = null
  if (browserServer) {
    const process = browserServer.process()
    const exited = new Promise(resolve => {
      if (!process || process.exitCode !== null) return resolve(process?.exitCode ?? null)
      process.once('exit', code => resolve(code))
    })
    await browserServer.close().catch(() => {})
    browserExit = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve('timeout'), 4000))])
  }
  result.cleanup.browserServerExitCode = browserExit
  if (studioStarted) await studioServer.close().catch(() => {})
  if (parentStarted) await closeServer(parent).catch(() => {})
  if (studioStarted) result.cleanup.studioPortRefusedAfterClose = await portRefuses(studioPort)
  if (parentStarted) result.cleanup.parentPortRefusedAfterClose = await portRefuses(parentPort)
  try {
    store?.close()
  } catch {
    result.cleanup.sqliteCloseError = true
  }
  result.cleanup.ownedServersClosed = result.cleanup.studioPortRefusedAfterClose === true
    && result.cleanup.parentPortRefusedAfterClose === true
  result.events = events
  if (failure) result.failure = failure
  writeFileSync(path.join(runDir, 'summary.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ runDir, result }, null, 2)}\n`)
  if (failure || Object.values(result.checks).some(value => value !== true) || result.cleanup.browserServerExitCode === 'timeout' || result.cleanup.studioPortRefusedAfterClose !== true || result.cleanup.parentPortRefusedAfterClose !== true) {
    process.exitCode = 1
  }
}
