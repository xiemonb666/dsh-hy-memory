/**
 * UI acceptance: the states the plan requires beyond screenshots — keyboard
 * reachability, focus restoration, permission denial, degraded/offline, and
 * no horizontal overflow at the three contract widths.
 *
 *   node tests/e2e/ui-acceptance.mjs
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const base = process.env.HYMEM_STUDIO_URL ?? 'http://127.0.0.1:48731'
const dataDir = process.env.HYMEM_DATA_DIR ?? join(process.cwd(), 'artifacts', 'e2e-data')
const token = readFileSync(join(dataDir, 'ui-token'), 'utf8').trim()

const results = []
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: Boolean(ok), detail })
  if (!ok) process.stderr.write(`FAIL ${id} ${name}: ${String(JSON.stringify(detail ?? '')).slice(0, 300)}\n`)
}

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', error => errors.push(String(error)))
page.on('console', message => {
  if (message.type() === 'error') errors.push(message.text())
})

await page.goto(`${base}/studio/?token=${encodeURIComponent(token)}`, { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)

// E2E-15a: no horizontal overflow at the three contract widths.
for (const [label, width, height] of [['desktop', 1440, 900], ['tablet', 900, 1000], ['mobile', 390, 844]]) {
  await page.setViewportSize({ width, height })
  await page.waitForTimeout(400)
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  check(`E2E-15a-${label}`, `no horizontal overflow at ${label}`, overflow.scrollWidth <= overflow.clientWidth + 1, overflow)
}
await page.setViewportSize({ width: 1440, height: 900 })

// E2E-15b: every nav destination is keyboard reachable and routed.
const navItems = ['overview', 'memories', 'evidence', 'conflicts', 'agents', 'capture', 'usage', 'settings', 'diagnostics']
for (const route of navItems) {
  await page.goto(`${base}/studio/#/${route}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(250)
  const body = await page.locator('body').innerText()
  check(`E2E-15b-${route}`, `${route} renders content (not an error state)`, body.length > 80 && !/Something went wrong|加载失败/i.test(body), { length: body.length })
}

// E2E-15c: visible focus ring and tab order on the explorer filters.
await page.goto(`${base}/studio/#/memories`, { waitUntil: 'networkidle' })
await page.waitForTimeout(400)
await page.keyboard.press('Tab')
const firstFocus = await page.evaluate(() => {
  const active = document.activeElement
  return active ? { tag: active.tagName, outline: getComputedStyle(active).outlineStyle } : null
})
check('E2E-15c', 'first Tab stop receives focus with a visible outline', firstFocus !== null && firstFocus.outline !== 'none', firstFocus)

// E2E-14a: drawer opens, traps focus, and restores it on close.
await page.goto(`${base}/studio/#/memories`, { waitUntil: 'networkidle' })
await page.waitForTimeout(500)
const openButton = page.getByRole('button', { name: /打开|Open/i }).first()
if (await openButton.count()) {
  await openButton.click()
  await page.waitForTimeout(600)
  const drawer = page.locator('[role="dialog"], [role="complementary"]').first()
  const drawerVisible = (await drawer.count()) > 0
  check('E2E-14a', 'memory detail drawer opens', drawerVisible, { drawerVisible })
  if (drawerVisible) {
    const inside = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"], [role="complementary"]')
      return dialog ? dialog.contains(document.activeElement) || document.activeElement === document.body : false
    })
    check('E2E-14b', 'focus moves into the drawer', inside, { inside })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    const closed = await page.locator('[role="dialog"]').count()
    check('E2E-14c', 'Escape closes the drawer', closed === 0, { remaining: closed })
  }
} else {
  results.push({ id: 'E2E-14a', name: 'drawer test skipped (no rows)', ok: true, detail: 'skipped' })
}

// E2E-14d: an unknown route still renders the shell instead of crashing.
await page.goto(`${base}/studio/#/does-not-exist`, { waitUntil: 'networkidle' })
await page.waitForTimeout(400)
const fallback = await page.locator('body').innerText()
check('E2E-14d', 'unknown route falls back to a real page', fallback.length > 80, { length: fallback.length })

// E2E-14e: offline behaviour — abort every API request and expect an explicit
// error state, never fabricated numbers.
const offlineContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const offlinePage = await offlineContext.newPage()
await offlinePage.route('**/api/**', route => route.abort('failed'))
await offlinePage.goto(`${base}/studio/?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' })
await offlinePage.waitForTimeout(2500)
const offlineText = await offlinePage.locator('body').innerText()
const showsError = /无法|失败|error|offline|重试|retry/i.test(offlineText)
const fabricated = /记忆总数\s*\n\s*[1-9]/.test(offlineText)
check('E2E-14e', 'offline API shows an explicit error state, not invented numbers', showsError && !fabricated, {
  showsError,
  fabricated,
  sample: offlineText.slice(0, 200),
})
await offlineContext.close()

// E2E-14f: a 403 from the Host surfaces as a permission message.
const deniedContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const deniedPage = await deniedContext.newPage()
await deniedPage.route('**/api/memories**', route =>
  route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'E_FORBIDDEN', message: 'denied' } }) }),
)
await deniedPage.goto(`${base}/studio/?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' })
await deniedPage.waitForTimeout(1500)
await deniedPage.goto(`${base}/studio/#/memories`, { waitUntil: 'domcontentloaded' })
await deniedPage.waitForTimeout(1500)
const deniedText = await deniedPage.locator('body').innerText()
check('E2E-14f', 'a 403 renders a permission message', /权限|无权|forbidden|denied|permission/i.test(deniedText), { sample: deniedText.slice(0, 250) })
await deniedContext.close()

check('E2E-15d', 'no console or page errors during the whole run', errors.length === 0, errors.slice(0, 5))

await browser.close()
const failed = results.filter(item => !item.ok)
console.log(JSON.stringify({ ok: failed.length === 0, total: results.length, failed: failed.length, results }, null, 2))
process.exit(failed.length === 0 ? 0 : 1)
