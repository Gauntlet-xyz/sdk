import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.ts'],
    exclude: ['tests/utils.ts', '**/node_modules/**'],
    fileParallelism: false,
  },
});
