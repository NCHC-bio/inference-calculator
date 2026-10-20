import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'node', include: ['packages/{core,data,schema}/test/**/*.test.ts'] } },
      'packages/web/vitest.config.ts',
    ],
  },
});
