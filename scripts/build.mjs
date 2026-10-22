/**
 * Build the installable bundle into an isolated empty directory, then emit the
 * Cordis patch and a verifiable SHA-256 manifest.
 *
 * The bundle is plain JavaScript (no build-time DSH imports) so it can be
 * installed into a profile as a linked directory and loaded by the Loader.
 */
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPrivateBundlePath, parseBuildOptions, publishBuildOutput } from './build-options.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { out: targetOut } = parseBuildOptions(process.argv.slice(2), { repoRoot: root })
mkdirSync(dirname(targetOut), { recursive: true })
parseBuildOptions(['--out', targetOut], { repoRoot: root })
const out = mkdtempSync(join(dirname(targetOut), '.dsh-hymem-stage-'))

try {

const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: false,
  logLevel: 'info',
  external: ['node:*'],
}

// 1) Host entry: the Cordis plugin.
await build({
  ...shared,
  entryPoints: [join(root, 'packages/host-plugin/src/index.ts')],
  outfile: join(out, 'index.js'),
})

// 2) Studio API + UI server (also usable by the CLI).
await build({
  ...shared,
  entryPoints: [join(root, 'packages/host-plugin/src/studio.ts')],
  outfile: join(out, 'studio-api.js'),
})

// 3) CLI: doctor / status / install / uninstall / backup / export.
await build({
  ...shared,
  entryPoints: [join(root, 'scripts/cli.ts')],
  outfile: join(out, 'cli.js'),
})

// 4) Studio SPA (already built by vite) and metadata.
const studioDist = join(root, 'packages/ui-client/dist')
if (!existsSync(join(studioDist, 'index.html'))) {
  throw new Error('UI is not built; run `pnpm --filter @dsh-hy-memory/ui-client build` first')
}
cpSync(studioDist, join(out, 'studio'), {
  recursive: true,
  filter: source => !isPrivateBundlePath(relative(studioDist, source)),
})
cpSync(join(root, 'packages/host-plugin/client/client.js'), join(out, 'client.js'))
mkdirSync(join(out, 'locale'), { recursive: true })
cpSync(join(root, 'packages/ui-client/locale/en.json'), join(out, 'locale/en.json'))
cpSync(join(root, 'packages/ui-client/locale/zh.json'), join(out, 'locale/zh.json'))
cpSync(join(root, 'packages/ui-client/icon.svg'), join(out, 'icon.svg'))
cpSync(join(root, 'python/hymem_worker'), join(out, 'python/hymem_worker'), {
  recursive: true,
  filter: source => !isPrivateBundlePath(relative(join(root, 'python/hymem_worker'), source)),
})
cpSync(join(root, 'LICENSE'), join(out, 'LICENSE'))
cpSync(join(root, 'NOTICE'), join(out, 'NOTICE'))

const packageJson = {
  name: 'dsh-hy-memory',
  version: '0.1.0',
  private: true,
  type: 'module',
  description: 'HyMemory Studio for DeepSeek Harness — native long-term memory with evidence, ACL and version validity',
  exports: {
    '.': './index.js',
    './client': './client.js',
    './studio-api': './studio-api.js',
    './locale/*.json': './locale/*.json',
    './icon': './icon.svg',
    './package.json': './package.json',
  },
  files: ['index.js', 'client.js', 'studio-api.js', 'cli.js', 'studio/**', 'python/**', 'locale/*.json', 'icon.svg', 'cordis.patch.yml', 'LICENSE', 'NOTICE', 'SHA256SUMS.json'],
  dsh: {
    bundle: { patch: './cordis.patch.yml' },
    client: {
      platform: 'web',
      immediately: false,
      inject: ['@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-plugin-manager'],
    },
  },
  engines: { node: '>=24' },
  license: 'Apache-2.0',
}
writeFileSync(join(out, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`)

const patch = `# HyMemory Studio bundle layer.
# Inserts one host row; the profile's own patch layer and the home-level patch
# still outrank this file, so a user can disable or reconfigure the plugin
# without editing the bundle.
- insert:
    - id: hy-memory
      name: dsh-hy-memory
      config:
        enabled: true
        worker:
          autoSpawn: true
          engine: auto
        ui:
          enabled: true
          host: 127.0.0.1
          port: 48731
        recall:
          enabled: true
          mode: clue-first
          trigger: task-boundary
        capture:
          enabled: true
          autoCapture: true
`
writeFileSync(join(out, 'cordis.patch.yml'), patch)

function collectBundleFiles(directory, base = directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error(`Bundle output contains a symlink: ${path}`)
    if (entry.isDirectory()) {
      files.push(...collectBundleFiles(path, base))
    } else if (entry.isFile()) {
      if (isPrivateBundlePath(relative(base, path))) throw new Error(`Refusing to package a private environment or data file: ${path}`)
      if (entry.name === 'SHA256SUMS.json' && directory === base) continue
      files.push(relative(base, path).split(sep).join('/'))
    } else {
      throw new Error(`Bundle output contains an unsupported filesystem entry: ${path}`)
    }
  }
  return files.sort()
}

const checksums = Object.fromEntries(collectBundleFiles(out).map(path => [
  path,
  createHash('sha256').update(readFileSync(join(out, path))).digest('hex'),
]))
const checksumPath = join(out, 'SHA256SUMS.json')
writeFileSync(checksumPath, `${JSON.stringify({ algorithm: 'sha256', files: checksums }, null, 2)}\n`)
const writtenManifest = JSON.parse(readFileSync(checksumPath, 'utf8'))
for (const [path, digest] of Object.entries(writtenManifest.files)) {
  const actual = createHash('sha256').update(readFileSync(join(out, path))).digest('hex')
  if (actual !== digest) throw new Error(`Bundle checksum verification failed for ${path}`)
}

const size = readFileSync(join(out, 'index.js')).length
publishBuildOutput(out, targetOut, { repoRoot: root })
console.log(`bundle written to ${targetOut} (host entry ${size} bytes)`)
} finally {
  rmSync(out, { recursive: true, force: true })
}
