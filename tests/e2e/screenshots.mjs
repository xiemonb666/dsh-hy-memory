/**
 * Capture Studio screenshots at three widths in light and dark themes, plus the
 * DSH sidebar entry that hosts the panel. Fails loudly when a page reports an
 * error state instead of silently writing a blank image.
 */
import { chromium } from 'playwright'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const outDir = join(process.cwd(), 'assets', 'screenshots')
mkdirSync(outDir, { recursive: true })
const token = readFileSync(join(process.cwd(), 'artifacts', 'e2e-data', 'ui-token'), 'utf8').trim()
const base = process.env.HYMEM_STUDIO_URL ?? 'http://127.0.0.1:48731'
const dshUrl = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:58231'

const routes = [
  ['overview', '01-overview'],
  ['memories', '02-memory-explorer'],
  ['evidence', '03-evidence-versions'],
  ['conflicts', '04-conflicts'],
  ['agents', '05-agents-permissions'],
  ['capture', '06-capture-queue'],
  ['usage', '07-usage-quality'],
  ['settings', '08-settings'],
  ['diagnostics', '09-diagnostics'],
]

const viewports = [
  ['desktop', { width: 1440, height: 900 }],
  ['tablet', { width: 900, height: 1000 }],
  ['mobile', { width: 390, height: 844 }],
]

const browser = await chromium.launch()
const results = []
for (const [theme, colorScheme] of [['light', 'light'], ['dark', 'dark']]) {
  const context = await browser.newContext({ colorScheme, viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto(`${base}/studio/?token=${encodeURIComponent(token)}`, { waitUntil: 'networkidle' })
  for (const [route, name] of routes) {
    await page.goto(`${base}/studio/#/${route}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(350)
    const body = await page.locator('body').innerText()
    if (/Something went wrong|加载失败|Application error/i.test(body)) {
      throw new Error(`route ${route} rendered an error state: ${body.slice(0, 200)}`)
    }
    for (const [label, viewport] of viewports) {
      await page.setViewportSize(viewport)
      await page.waitForTimeout(200)
      const file = join(outDir, `${name}-${label}-${theme}.png`)
      await page.screenshot({ path: file, fullPage: false })
      results.push({ route, label, theme, file })
    }
    await page.setViewportSize({ width: 1440, height: 900 })
  }
  if (errors.length > 0) throw new Error(`console errors: ${errors.slice(0, 5).join(' | ')}`)
  await context.close()
}

// The DSH host page: prove the plugin contributed its sidebar entry.
const dshContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const dshPage = await dshContext.newPage()
const boot = await fetch(dshUrl).then(response => response.text())
const tokenMatch = /token=([A-Za-z0-9_-]+)/.exec(boot)
const dshToken = tokenMatch?.[1]
if (!dshToken) {
  const html = await fetch(`${dshUrl}/?token=${process.env.DSH_WEB_TOKEN ?? ''}`).then(response => response.text())
  if (html.includes('Unauthorized')) throw new Error('cannot authenticate to the DSH web UI; set DSH_WEB_TOKEN')
}
await dshPage.goto(`${dshUrl}/?token=${dshToken ?? process.env.DSH_WEB_TOKEN}`, { waitUntil: 'networkidle' })
await dshPage.waitForTimeout(2500)
const sidebarText = await dshPage.locator('body').innerText()
const hasEntry = /HyMemory/i.test(sidebarText)
await dshPage.screenshot({ path: join(outDir, '10-dsh-sidebar-entry.png'), fullPage: false })
results.push({ route: 'dsh-sidebar', hasEntry })
await dshContext.close()

await browser.close()
console.log(JSON.stringify({ ok: true, count: results.length, hasSidebarEntry: hasEntry, results }, null, 2))
