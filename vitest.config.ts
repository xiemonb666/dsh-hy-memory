import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const resolve = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@dsh-hy-memory/contracts': resolve('./packages/contracts/src/index.ts'),
      '@dsh-hy-memory/governance': resolve('./packages/governance/src/index.ts'),
      '@dsh-hy-memory/retrieval': resolve('./packages/retrieval/src/index.ts'),
      '@dsh-hy-memory/coding-trace': resolve('./packages/coding-trace/src/index.ts'),
      '@dsh-hy-memory/host-plugin': resolve('./packages/host-plugin/src/index.ts'),
      '@dsh-hy-memory/host-plugin/capture': resolve('./packages/host-plugin/src/capture.ts'),
      '@dsh-hy-memory/host-plugin/recall': resolve('./packages/host-plugin/src/recall.ts'),
      '@dsh-hy-memory/host-plugin/config': resolve('./packages/host-plugin/src/config.ts'),
      '@dsh-hy-memory/host-plugin/studio': resolve('./packages/host-plugin/src/studio.ts'),
      '@dsh-hy-memory/testing': resolve('./packages/testing/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**', '.upstream/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ['verbose'],
  },
})