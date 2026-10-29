// Stands in for Open Food Facts and USDA during e2e, answering from the responses recorded in
// test/fixtures, so the browser pass never touches the network. A request matches a fixture
// by path, plus the search text for search endpoints.
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', 'test', 'fixtures');
const port = Number(process.env.FUEL_UPSTREAM_PORT ?? 8790);

const keyOf = (url) => {
  const q = url.searchParams.get('q') ?? url.searchParams.get('query');
  return q === null ? url.pathname : `${url.pathname}?${q.trim().toLowerCase()}`;
};

const recorded = new Map();
for (const source of ['off', 'usda']) {
  let files = [];
  try {
    files = readdirSync(join(root, source)).filter((f) => f.endsWith('.json'));
  } catch {
    continue;
  }
  for (const file of files) {
    const fixture = JSON.parse(readFileSync(join(root, source, file), 'utf8'));
    recorded.set(keyOf(new URL(fixture.request)), fixture);
  }
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/healthz') return send(200, { ok: true, fixtures: recorded.size });
  const fixture = recorded.get(keyOf(url));
  if (fixture !== undefined) return send(fixture.status, fixture.body);
  if (url.pathname.startsWith('/api/v2/product/')) return send(404, { status: 0, status_verbose: 'product not found' });
  if (url.pathname === '/search') return send(200, { hits: [], count: 0 });
  return send(404, { error: `no fixture for ${url.pathname}` });
}).listen(port, '127.0.0.1');
