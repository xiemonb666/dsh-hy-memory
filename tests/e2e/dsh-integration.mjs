/**
 * Verify the native DSH browser integration against an isolated Host:
 * sidebar entries, Plugins details/config slot, authenticated Studio health,
 * and the nine routed Studio pages. All screenshots go to the explicit
 * DSH_E2E_OUTPUT_DIR when supplied.
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

function redact(value, secrets = []) {
  let safe = String(value)
  for (const secret of secrets) if (secret) safe = safe.replaceAll(secret, '[REDACTED]')
  return safe
    .replace(/([?&]token=)[^&#\s"'<>]+/gi, '$1[REDACTED]')
    .replace(/(authorization\s*:\s*bearer\s+)[^\s"'<>]+/gi, '$1[REDACTED]')
}

async function closeOwnedBrowser(browser, browserServer, timeoutMs = 15_000) {
  if (!browserServer) {
    await browser?.close().catch(() => undefined)
    return { browserStarted: false, browserClosed: null, forcedBrowserTreeTermination: false, browserPid: null }
  }
  const browserPid = browserServer.process()?.pid ?? null
  const closeOperations = Promise.allSettled([
    browser?.close().catch(() => undefined) ?? Promise.resolve(),
    browserServer.close().catch(() => undefined),
  ])
  let timer
  const gracefullyClosed = await Promise.race([
    closeOperations.then(() => true),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs) }),
  ])
  if (timer) clearTimeout(timer)
  let forcedBrowserTreeTermination = false
  if (!gracefullyClosed && browserPid && await pidIsRunning(browserPid)) {
    forcedBrowserTreeTermination = true
    let killTimer
    const browserKill = browserServer.kill().catch(() => undefined)
    const killFinished = await Promise.race([
      browserKill.then(() => true),
      new Promise(resolve => { killTimer = setTimeout(() => resolve(false), 5000) }),
    ])
    if (killTimer) clearTimeout(killTimer)
    if (!killFinished && process.platform === 'win32' && await pidIsRunning(browserPid)) {
      const taskkillPath = join(process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'taskkill.exe')
      const taskkill = spawn(taskkillPath, ['/PID', String(browserPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      await new Promise(resolve => {
        const timerId = setTimeout(() => { taskkill.kill(); resolve(false) }, 5000)
        taskkill.once('close', () => { clearTimeout(timerId); resolve(true) })
        taskkill.once('error', () => { clearTimeout(timerId); resolve(false) })
      })
    } else if (!killFinished && process.platform !== 'win32') {
      try { process.kill(browserPid, 'SIGKILL') } catch { /* the owned browser may already have exited */ }
    }
    await browserServer.close().catch(() => undefined)
  }
  const browserClosed = browserPid ? await waitForPidStop(browserPid, 5000) : null
  return { browserStarted: true, browserClosed, forcedBrowserTreeTermination, browserPid }
}

async function waitForPidStop(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { process.kill(pid, 0) } catch (error) { return error?.code !== 'EPERM' }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  try { process.kill(pid, 0); return false } catch (error) { return error?.code !== 'EPERM' }
}

const outputDir = join(process.env.DSH_E2E_OUTPUT_DIR ?? join(process.cwd(), 'artifacts', 'dsh-native', 'screenshots'))
mkdirSync(outputDir, { recursive: true })
const dshBase = process.env.DSH_WEB_URL
const token = process.env.DSH_WEB_TOKEN
const studioBase = process.env.HYMEM_STUDIO_URL
const browserPidFile = process.env.DSH_E2E_BROWSER_PID_FILE
if (!dshBase || !token) throw new Error('DSH_WEB_URL and DSH_WEB_TOKEN are required')
const dshOrigin = new URL(dshBase).origin
if (new URL(dshBase).hostname !== '127.0.0.1' || new URL(dshBase).protocol !== 'http:') {
  throw new Error('DSH_WEB_URL must be a loopback HTTP origin')
}
const expectedStudioOrigin = studioBase ? new URL(studioBase).origin : null
if (studioBase && (new URL(studioBase).hostname !== '127.0.0.1' || new URL(studioBase).protocol !== 'http:')) {
  throw new Error('HYMEM_STUDIO_URL must be a loopback HTTP origin')
}

function isLoopbackHttp(url) {
  return (url.protocol === 'http:' || url.protocol === 'https:') && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
}

const errors = []
const blockedExternalOrigins = new Set()
const browserSecrets = [token]
const report = {
  ok: false,
  steps: [],
  routes: [],
  onboarding: { status: 'NOT_RUN' },
  pluginsPanel: 'NOT_RUN',
  studio: { authenticatedHealth: 'NOT_RUN', overviewRendered: false },
  cleanup: { browserStarted: null, browserClosed: null, forcedBrowserTreeTermination: false, browserPid: null },
}
let browser
let browserServer
let browserContext
let page
const step = (name, value) => report.steps.push({ name, ...value })

try {
  browserServer = await chromium.launchServer({
    headless: true,
    ...(process.env.DSH_E2E_CHROMIUM_PATH ? { executablePath: process.env.DSH_E2E_CHROMIUM_PATH } : {}),
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'],
  })
  const browserEndpoint = browserServer.wsEndpoint()
  browserSecrets.push(browserEndpoint)
  const browserPid = browserServer.process()?.pid
  report.cleanup.browserPid = browserPid ?? null
  if (browserPidFile && browserPid) writeFileSync(browserPidFile, `${browserPid}\n`, { encoding: 'utf8', flag: 'wx' })
  report.cleanup.browserStarted = true
  browser = await chromium.connect(browserEndpoint)
  browserContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    serviceWorkers: 'block',
  })
  const allowedOrigins = new Set([dshOrigin, ...(expectedStudioOrigin ? [expectedStudioOrigin] : [])])
  await browserContext.route('**/*', async route => {
    let url
    try { url = new URL(route.request().url()) } catch { await route.continue(); return }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      await route.continue()
      return
    }
    if (isLoopbackHttp(url) && (allowedOrigins.has(url.origin) || !expectedStudioOrigin)) {
      await route.continue()
      return
    }
    if (url.protocol === 'http:' || url.protocol === 'https:') blockedExternalOrigins.add(url.origin)
    await route.abort('blockedbyclient')
  })
  page = await browserContext.newPage()
  page.on('pageerror', error => errors.push(redact(error.message, browserSecrets)))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(redact(message.text(), browserSecrets))
  })

  await page.goto(`${dshOrigin}/?token=${encodeURIComponent(token)}`, { waitUntil: 'networkidle', timeout: 45_000 })
  await page.waitForTimeout(1200)
  for (const label of ['继续', 'Continue', '我知道了', 'Got it']) {
    const button = page.getByRole('button', { name: label })
    if (await button.count()) {
      await button.first().click({ timeout: 2000 }).catch(() => undefined)
      await page.waitForTimeout(250)
    }
  }

  const getStartedDialog = page.getByRole('dialog', { name: /^(开始使用|Get started)$/ })
  if (await getStartedDialog.count() > 0) {
    const closeButton = getStartedDialog.getByRole('button', { name: /^(关闭|Close)$/ })
    await closeButton.waitFor({ state: 'visible', timeout: 5000 })
    await closeButton.click({ timeout: 5000 })
    await getStartedDialog.waitFor({ state: 'detached', timeout: 8000 })
    report.onboarding = { status: 'DISMISSED', dialog: 'first-run sign-in', control: 'localized close button' }
  } else {
    report.onboarding = { status: 'NOT_PRESENT' }
  }
  step('firstRunOnboarding', report.onboarding)

  const sidebar = page.locator('nav[aria-label], aside').first()
  const sidebarText = await sidebar.innerText().catch(() => '')
  const hasHyMemoryEntry = /HyMemory/i.test(sidebarText)
  const hasPluginsEntry = /Plugins|插件/i.test(sidebarText)
  step('sidebarEntries', { hasHyMemoryEntry, hasPluginsEntry })
  await page.screenshot({ path: join(outputDir, '10-dsh-sidebar-entry.png') })

  if (hasPluginsEntry) {
    const pluginsItem = sidebar.getByText(/^(Plugins|插件)$/i).first()
    if (await pluginsItem.count()) {
      await pluginsItem.click({ timeout: 5000 })
      await page.waitForTimeout(1200)
      const packageCard = page.locator('[data-plugin-package="dsh-hy-memory"]')
      await packageCard.waitFor({ state: 'visible', timeout: 8000 }).catch(() => undefined)
      const packageVisible = await packageCard.isVisible().catch(() => false)
      if (packageVisible) {
        await packageCard.getByRole('button', { name: /^(查看|View) HyMemory Studio$/i }).click({ timeout: 5000 })
      }
      const detail = page.locator('[data-plugin-detail="dsh-hy-memory"]')
      if (packageVisible) await detail.waitFor({ state: 'visible', timeout: 8000 }).catch(() => undefined)
      const detailVisible = await detail.isVisible().catch(() => false)
      const configSection = detail.locator('[data-plugin-config]')
      const configPageVisible = detailVisible && await configSection.isVisible().catch(() => false)
      const configFrame = configSection.locator('iframe[title*="HyMemory" i]')
      if (configPageVisible) await configFrame.waitFor({ state: 'visible', timeout: 8000 }).catch(() => undefined)
      const configFrameVisible = configPageVisible && await configFrame.isVisible().catch(() => false)
      report.pluginsPanel = packageVisible && detailVisible && configFrameVisible
        ? { status: 'PASS', bundleVisible: true, bundleDetailVisible: true, bundleConfigEntryVisible: configPageVisible }
        : { status: 'FAIL', bundleVisible: packageVisible, bundleDetailVisible: detailVisible, bundleConfigEntryVisible: configPageVisible, bundleConfigFrameVisible: configFrameVisible }
      step('pluginsPanel', report.pluginsPanel)
      await page.screenshot({ path: join(outputDir, '12-dsh-plugins-detail.png') })
    } else {
      report.pluginsPanel = { status: 'FAIL', bundleVisible: false }
    }
  } else {
    report.pluginsPanel = { status: 'FAIL', bundleVisible: false, reason: 'Plugins sidebar entry was not present' }
  }

  if (hasHyMemoryEntry) {
    await sidebar.getByText(/HyMemory/i).first().click({ timeout: 5000 })
    await page.waitForTimeout(900)
  }
  const frameLocator = page.locator('iframe[title*="HyMemory" i]').first()
  const frameCount = await frameLocator.count()
  step('studioIframe', { count: frameCount })
  await page.screenshot({ path: join(outputDir, '11-dsh-hymemory-panel.png') })

  let frame = null
  if (frameCount > 0) {
    const element = await frameLocator.elementHandle()
    frame = element ? await element.contentFrame() : null
  }
  if (!frame) throw new Error('HyMemory Studio iframe did not load')
  const studioOrigin = new URL(await frame.url()).origin
  if (!isLoopbackHttp(new URL(studioOrigin)) || (expectedStudioOrigin && studioOrigin !== expectedStudioOrigin)) {
    throw new Error('HyMemory iframe origin does not match the isolated loopback Studio')
  }
  await frame.waitForSelector('#root', { state: 'attached', timeout: 20_000 })
  await frame.locator('#root').waitFor({ state: 'visible', timeout: 20_000 })
  const studioHeaders = await frame.evaluate(async () => {
    const response = await fetch('/studio/', { credentials: 'include' })
    return { status: response.status, csp: response.headers.get('content-security-policy') }
  })
  const csp = studioHeaders.status === 200 ? studioHeaders.csp : null
  report.studio.cspAllowsDshOrigin = Boolean(csp?.includes(dshOrigin))
  const health = await frame.evaluate(async () => {
    const response = await fetch('/api/health', { credentials: 'include' })
    const body = await response.json()
    return {
      status: response.status,
      ok: body?.ok === true,
      engine: body?.worker?.engine ?? null,
      workerOk: body?.worker?.ok === true,
      degraded: body?.degraded === true,
      dbOk: body?.db?.ok === true,
    }
  })
  report.studio.authenticatedHealth = health.status === 200 && health.ok && health.engine === 'mock' && health.workerOk && health.dbOk
    ? { status: 'PASS', statusCode: health.status, engine: health.engine, workerOk: health.workerOk, degraded: health.degraded, dbOk: health.dbOk }
    : { status: 'FAIL', statusCode: health.status, engine: health.engine, workerOk: health.workerOk, degraded: health.degraded, dbOk: health.dbOk }

  const routes = ['overview', 'memories', 'evidence', 'conflicts', 'agents', 'capture', 'usage', 'settings', 'diagnostics']
  for (const route of routes) {
    const link = frame.locator(`nav.app__nav a[href="#/${route}"]`).first()
    const linkCount = await link.count()
    if (linkCount === 0) {
      report.routes.push({ name: route, ok: false, reason: 'navigation link missing' })
      continue
    }
    await link.click({ timeout: 7000 })
    await frame.waitForFunction(expected => window.location.hash === `#/${expected}`, route, { timeout: 7000 }).catch(() => undefined)
    const heading = await frame.locator('main h1').first().innerText({ timeout: 8000 }).catch(() => '')
    const current = await frame.evaluate(() => window.location.hash)
    const ok = current === `#/${route}` && heading.trim().length > 0
    report.routes.push({ name: route, ok, heading: heading.trim().slice(0, 100) })
    if (route === 'overview') {
      report.studio.overviewRendered = ok
      await page.screenshot({ path: join(outputDir, '13-studio-overview.png') })
    }
  }
  report.studio.healthEngine = health.engine
  report.browserErrors = errors.slice(0, 20)
  report.blockedExternalOrigins = [...blockedExternalOrigins].map(origin => new URL(origin).hostname).sort()
} catch (error) {
  report.error = redact(error instanceof Error ? error.message : String(error), browserSecrets)
  report.browserErrors = errors.slice(0, 20)
  report.blockedExternalOrigins = [...blockedExternalOrigins].map(origin => {
    try { return new URL(origin).hostname } catch { return '[invalid-origin]' }
  }).sort()
} finally {
  await Promise.race([
    browserContext?.close().catch(() => undefined) ?? Promise.resolve(),
    new Promise(resolve => setTimeout(resolve, 5000)),
  ])
  report.cleanup = { ...report.cleanup, ...await closeOwnedBrowser(browser, browserServer) }
}

const pageRoutesOk = report.routes.length === 9 && report.routes.every(route => route.ok)
const pluginPanelOk = typeof report.pluginsPanel === 'object' && report.pluginsPanel.status === 'PASS'
const healthOk = typeof report.studio.authenticatedHealth === 'object' && report.studio.authenticatedHealth.status === 'PASS'
report.ok = !report.error
  && report.steps.some(item => item.name === 'sidebarEntries' && item.hasHyMemoryEntry && item.hasPluginsEntry)
  && report.steps.some(item => item.name === 'studioIframe' && item.count > 0)
  && pluginPanelOk
  && healthOk
  && report.studio.cspAllowsDshOrigin === true
  && report.studio.overviewRendered === true
  && pageRoutesOk
  && errors.length === 0
  && blockedExternalOrigins.size === 0
  && report.cleanup.browserClosed === true
  && report.cleanup.forcedBrowserTreeTermination === false

console.log(JSON.stringify(report, null, 2))
process.exitCode = report.ok ? 0 : 1
