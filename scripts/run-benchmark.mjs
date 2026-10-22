/**
 * Bundle and run the offline benchmark. esbuild resolves the TypeScript
 * workspace sources so the benchmark measures the same code the plugin ships.
 */
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const out = join(process.cwd(), 'artifacts', 'benchmark-bundle.mjs')
mkdirSync(join(process.cwd(), 'artifacts'), { recursive: true })
await build({
  entryPoints: [join(process.cwd(), 'scripts', 'benchmark.mjs')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['node:*'],
  logLevel: 'error',
})
const result = spawnSync(process.execPath, [out, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(result.status ?? 1)
