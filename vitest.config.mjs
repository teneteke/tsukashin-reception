import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for the tsukashin reception settlement tool.
 *
 * The project ships as static files with `<script>` tag globals. To test the
 * existing code without a whole-project ESM refactor, tests run inside jsdom
 * so `window`, `document`, and related DOM APIs exist, and `test/setup.mjs`
 * loads every project JS file into the global scope via indirect eval.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.mjs'],
    include: ['test/**/*.test.mjs'],
    globals: false,
    coverage: {
      provider: 'v8',
      include: ['js/**/*.js'],
      exclude: ['lib/**', 'test/**'],
      reporter: ['text', 'html'],
    },
  },
});
