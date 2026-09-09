import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  // A managed MCP fixture includes server + browser startup, and MCP's own
  // default navigation timeout is 60s. Keep the runner timeout above that so
  // slow cold starts fail at the transport boundary instead of being cut off.
  timeout: 90_000,
});
