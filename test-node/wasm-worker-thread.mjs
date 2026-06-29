// Worker thread code for wasm-worker-test.mjs
//
// Spawned by wasm-worker-test.mjs as a worker_threads.Worker with
// application-specific workerData: { sessionId, config } — NOT the
// { mod, name, type } format that the web-worker polyfill uses internally.
//
// Regression: without the patch to duckdb-node.cjs, importing
// @run-trace/duckdb-wasm from this context runs the polyfill's He() bootstrap,
// which silently fails (require(undefined)), then mutates the global object
// (sets global.postMessage, modifies prototype chain).
//
// With the patch:
//   - He() is guarded — only runs when workerData.mod is a string
//   - NodeWorker is exported — works identically in main thread and worker thread

import { parentPort, workerData } from 'node:worker_threads';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, '..', 'packages', 'duckdb-wasm', 'dist');

async function run() {
  // Check global state before import — He() sets global.postMessage if it runs
  const globalPostMessageBefore = typeof globalThis.postMessage;

  // Import from a worker thread with app-specific workerData.
  // Without the patch this mutates the global; with the patch it's clean.
  const duckdb = await import('@run-trace/duckdb-wasm');

  const globalPostMessageAfter = typeof globalThis.postMessage;

  const BUNDLES = {
    eh: {
      mainModule: join(DIST_DIR, 'duckdb-eh.wasm'),
      mainWorker: join(DIST_DIR, 'duckdb-node-eh.worker.cjs'),
    },
  };

  const bundle = await duckdb.selectBundle(BUNDLES);
  const logger = new duckdb.VoidLogger();

  // NodeWorker works identically here as it does on the main thread —
  // no custom adapter, no import('web-worker') needed.
  const worker = new duckdb.NodeWorker(bundle.mainWorker);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule);
  await db.open({});

  const conn = await db.connect();

  const v = await conn.query('SELECT version() AS v');
  const version = String(v.get(0).v);

  const h = await conn.query("SELECT row_hash('user1', 'hello') AS h");
  const hash = String(h.get(0).h);

  await conn.close();
  await db.terminate();
  worker.terminate();

  parentPort.postMessage({
    type: 'ok',
    version,
    hash,
    sessionId: workerData.sessionId,
    globalClean: globalPostMessageBefore === 'undefined' && globalPostMessageAfter === 'undefined',
  });
}

run().catch((err) => {
  parentPort.postMessage({ type: 'error', message: err.message, stack: err.stack });
});
