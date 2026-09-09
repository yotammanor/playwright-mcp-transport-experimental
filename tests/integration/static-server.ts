import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
};

export type StaticServer = { url: string; close: () => Promise<void> };

/** Serves tests/integration/fixtures over HTTP, since @playwright/mcp blocks the file: protocol. */
export async function startStaticServer(): Promise<StaticServer> {
  const server = http.createServer((req, res) => {
    if ((req.url ?? '').startsWith('/redirect')) {
      res.writeHead(302, { location: '/shim.html' }).end();
      return;
    }
    if ((req.url ?? '').startsWith('/echo')) {
      let body = '';
      req.setEncoding('utf-8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ body, url: req.url }));
      });
      return;
    }
    const requestedPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    const resolved = path.normalize(path.join(FIXTURES_DIR, requestedPath));
    if (!resolved.startsWith(FIXTURES_DIR)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(resolved, (err, data) => {
      if (err) {
        res.writeHead(404).end('Not found');
        return;
      }
      res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(resolved)] ?? 'application/octet-stream' });
      res.end(data);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
