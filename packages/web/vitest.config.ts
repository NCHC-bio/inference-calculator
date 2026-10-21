import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
    // Most specs render the whole App in jsdom and type into antd inputs; under full-suite load (and on slower CI
    // runners) one such test can pass 5 s, so the project default is raised rather than per test (review I1).
    testTimeout: 20000,
  },
});
