import { defineConfig } from 'vitest/config'

// Default unit tests run in the Node pool and exercise the Hono app via
// `app.request()` — no bindings needed. For tests that hit D1/KV/R2 bindings,
// switch to `@cloudflare/vitest-pool-workers` (runs inside workerd).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
