import { defineConfig } from 'vitest/config'

/**
 * Test configuration.
 *
 * The pool is fixed to threads: the fork pool spawns child processes, which
 * some sandboxes refuse, and the runtime suite boots a real Cordis context that
 * does not need process isolation.
 */
export default defineConfig({
  test: {
    environment: 'node',
    pool: 'threads',
    include: ['test/**/*.test.ts'],
  },
})
