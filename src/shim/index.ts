import { test as base, expect as baseExpect } from '@playwright/test';
import { createMcpTest } from './factory.js';

export { createMcpTest } from './factory.js';
export { ShimPage } from './page.js';
export { ShimLocator } from './locator.js';

/**
 * A "best effort" Playwright-Page-shaped adapter over the MCP transport,
 * meant to be swapped in for real suites via a `page` fixture override so
 * existing test files need zero (or near-zero) edits. Event delivery is
 * reconstructed from retained server data, polling, or an atomic native
 * operation, so it cannot provide the timing fidelity of Playwright's pushed
 * protocol stream. Same-context pages are supported through serialized tab
 * selection; creating independent contexts through the `browser` fixture and
 * request-dependent live route mutations remain outside this adapter.
 *
 * This default export wires up against *this package's own* `@playwright/test`
 * install — fine for this repo's own tests. A different repo swapping in this
 * transport should use `createMcpTest(test, expect)` from its own local
 * wrapper file instead, importing `test`/`expect` from its own
 * `@playwright/test` install (see factory.ts for why).
 */
export const { test, expect } = createMcpTest(base, baseExpect);
