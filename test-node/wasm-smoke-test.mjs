#!/usr/bin/env node
// Smoke test for @run-trace/duckdb-wasm Node.js bindings.
//
// Verifies:
//   1. The WASM package loads and instantiates in Node.js
//   2. Basic SQL queries work
//   3. Bundled extensions (JSON, hash_ext, lua) are available
//
// This test would have caught issues like:
//   - crypto.randomFillSync errors from bad Emscripten patches
//   - Missing or broken WASM binaries
//   - Extension init failures
//
// Usage: node test-node/wasm-smoke-test.mjs
//
// Requires: npm install in test-node/ AND a built dist/ in packages/duckdb-wasm/

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, '..', 'packages', 'duckdb-wasm', 'dist');

// ---------------------------------------------------------------------------
// Preflight: check that dist/ exists
// ---------------------------------------------------------------------------
if (!existsSync(DIST_DIR)) {
  console.error('ERROR: packages/duckdb-wasm/dist/ not found. Run the WASM build first.');
  process.exit(1);
}

if (!existsSync(join(DIST_DIR, 'duckdb-eh.wasm'))) {
  console.error('ERROR: duckdb-eh.wasm not found in dist/. Run the WASM build first.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(condition, label, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.log(`  FAIL  ${label}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('--- Loading @run-trace/duckdb-wasm ---');

  // Import our WASM package
  const duckdb = await import('@run-trace/duckdb-wasm');
  assert(duckdb.AsyncDuckDB !== undefined, 'AsyncDuckDB export exists');
  assert(duckdb.selectBundle !== undefined, 'selectBundle export exists');
  assert(duckdb.createWorker !== undefined, 'createWorker export exists');

  // Configure bundles pointing at our dist/
  const BUNDLES = {
    eh: {
      mainModule: join(DIST_DIR, 'duckdb-eh.wasm'),
      mainWorker: join(DIST_DIR, 'duckdb-node-eh.worker.cjs'),
    },
  };

  console.log('--- Selecting bundle ---');
  const bundle = await duckdb.selectBundle(BUNDLES);
  console.log(`  Selected: eh`);

  console.log('--- Instantiating DuckDB ---');
  const logger = new duckdb.ConsoleLogger();
  // createWorker uses fetch() which doesn't work with file:// in Node.js.
  // Use the web-worker polyfill directly (same as createWorker but without fetch).
  const { default: Worker } = await import('web-worker');
  const worker = new Worker(bundle.mainWorker);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  assert(true, 'DuckDB instantiated');

  await db.open({});
  assert(true, 'Database opened');

  const conn = await db.connect();
  assert(true, 'Connected');

  // --- Basic query ---
  console.log('--- Basic queries ---');
  const v = await conn.query("SELECT version() AS v");
  const version = String(v.get(0).v);
  assert(version.startsWith('v'), 'DuckDB version string present', `got ${version}`);

  const r42 = await conn.query("SELECT 42::INTEGER AS answer");
  assert(Number(r42.get(0).answer) === 42, 'SELECT 42 works');

  // --- JSON extension ---
  console.log('--- JSON extension ---');
  try {
    const j = await conn.query("SELECT json_extract('{\"x\":99}','$.x')::INTEGER AS val");
    assert(Number(j.get(0).val) === 99, 'json_extract works');
  } catch (e) {
    assert(false, 'json_extract works', e.message);
  }

  // --- hash_ext extension ---
  console.log('--- hash_ext extension ---');
  try {
    const h = await conn.query("SELECT row_hash('user1', 'hello') AS h");
    assert(String(h.get(0).h) === 'b640d6eba4e95e3a', 'row_hash known value');
  } catch (e) {
    assert(false, 'row_hash works', e.message);
  }

  // --- lua extension ---
  console.log('--- lua extension ---');
  try {
    const l = await conn.query("SELECT lua('return 40 + 2') AS result");
    const luaResult = String(l.get(0).result);
    assert(luaResult.includes('42'), 'lua eval works', `got ${luaResult}`);
  } catch (e) {
    assert(false, 'lua eval works', e.message);
  }

  // --- Cleanup ---
  await conn.close();
  await db.terminate();
  worker.terminate();

  // --- Summary ---
  console.log('');
  console.log('========================================');
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('========================================');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
