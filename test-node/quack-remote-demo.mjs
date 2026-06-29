#!/usr/bin/env node
// Quack remote-querying demo (NODE): native DuckDB host <-- HTTP --> DuckDB-WASM client.
//
//   - HOST   : native DuckDB via @duckdb/node-api (quack-host.mjs) — quack_serve.
//   - CLIENT : our @run-trace/duckdb-wasm build, run in a Node worker. Node has no
//              XMLHttpRequest (which duckdb-wasm's HTTP needs), so the worker is
//              wrapped to inject a robust synchronous XHR (sync-xhr-node.cjs:
//              Atomics + a fetch worker). In a browser this shim is unnecessary —
//              see quack-browser-demo.mjs for the native-XHR browser path.
//
// Usage: node test-node/quack-remote-demo.mjs
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { startHost } from './quack-host.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, '..', 'packages', 'duckdb-wasm', 'dist');
const URI = 'quack:localhost:9494';
const TOKEN = 'super_secret';
const log = (side, msg) => console.log(`[${side}] ${msg}`);

async function runClient() {
  if (!existsSync(join(DIST_DIR, 'duckdb-eh.wasm'))) {
    throw new Error('packages/duckdb-wasm/dist not built — run ./trace-scripts/build-wasm.sh');
  }
  log('client', 'instantiating @run-trace/duckdb-wasm (Node)…');
  const duckdb = await import('@run-trace/duckdb-wasm');
  const bundle = await duckdb.selectBundle({
    eh: {
      mainModule: join(DIST_DIR, 'duckdb-eh.wasm'),
      // Wrapper worker injects the synchronous XHR shim, then loads the real worker.
      mainWorker: join(__dirname, 'duckdb-quack-worker.cjs'),
    },
  });
  const { default: Worker } = await import('web-worker');
  const worker = new Worker(bundle.mainWorker);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  await db.open({ allowUnsignedExtensions: true });
  const conn = await db.connect();

  const out = await runQuackClient(conn, { uri: URI, token: TOKEN, log: (m) => log('client', m) });

  await conn.close();
  await db.terminate();
  worker.terminate();
  return out;
}

// Shared client steps (same SQL the browser page runs). quack is statically linked
// into our wasm build and auto-loaded — no INSTALL/LOAD needed.
export async function runQuackClient(conn, { uri, token, log = () => {} }) {
  const jnum = (_k, v) => (typeof v === 'bigint' ? Number(v) : v);

  log(`attaching host: ${uri}`);
  await conn.query(`CREATE SECRET quack_secret (TYPE quack, TOKEN '${token}')`);
  await conn.query(`ATTACH '${uri}' AS remote`);

  log('SELECT * FROM remote.products …');
  const r = await conn.query('SELECT id, name, price::DOUBLE AS price FROM remote.products ORDER BY id');
  const rows = r.toArray().map((row) => row.toJSON());

  log('write-back: CREATE TABLE remote.from_wasm …');
  await conn.query(`CREATE TABLE remote.from_wasm AS SELECT 99 AS magic, 'hello from wasm' AS note`);

  log('calling server-side UDF via quack_query(loyalty_points)…');
  const u = await conn.query(
    `SELECT * FROM quack_query('${uri}',
       'SELECT id, name, loyalty_points(price::DOUBLE) AS points FROM products ORDER BY id',
       token => '${token}')`
  );
  const udfRows = u.toArray().map((row) => row.toJSON());

  return JSON.parse(JSON.stringify({ rows, udfRows }, jnum));
}

async function main() {
  const host = await startHost({ uri: URI, token: TOKEN, log: (m) => log('host', m) });
  let ok = false;
  try {
    const { rows, udfRows } = await runClient();
    console.log('       rows:', JSON.stringify(rows));
    console.log('       udf rows:', JSON.stringify(udfRows));
    const back = await host.readBack('SELECT magic, note FROM from_wasm');
    log('host', `sees client write-back: ${JSON.stringify(back)}`);
    ok = rows.length === 3 && Number(back?.[0]?.magic) === 99 &&
         udfRows.length === 3 && Number(udfRows[0].points) === 90 && Number(udfRows[2].points) === 290;
  } finally {
    await host.stop();
  }
  console.log('\n========================================');
  console.log(ok ? '  DEMO PASSED — Node wasm client queried native host over quack' : '  DEMO FAILED');
  console.log('========================================');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
