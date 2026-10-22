import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'scripts/**/*.spec.mjs', 'tests/**/*.spec.ts'],
    setupFiles: ['tests/setup.ts'],
  },
});
