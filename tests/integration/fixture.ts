import { test as mcpTest, expect } from '../../src/index.js';
import { startStaticServer, type StaticServer } from './static-server.js';

type Fixtures = { fixturesUrl: string };

export const test = mcpTest.extend<Fixtures>({
  fixturesUrl: async ({}, use) => {
    let server: StaticServer | undefined;
    try {
      server = await startStaticServer();
      await use(server.url);
    } finally {
      await server?.close();
    }
  },
});

export { expect };
