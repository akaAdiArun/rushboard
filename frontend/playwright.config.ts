import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  use: {
    baseURL: process.env.RUSHBOARD_BASE_URL ?? 'http://127.0.0.1:8080',
    viewport: { width: 1360, height: 790 },
    trace: 'retain-on-failure',
  },
});
