#!/usr/bin/env node
// Regression test: @run-trace/duckdb-wasm used from an application worker thread.
//
// Verifies the patch to duckdb-node.cjs that:
//   1. Guards He() so it doesn't mutate the global in non-DuckDB worker contexts
//   2. Exports NodeWorker — identical API in main thread and worker thread
//
// Usage: node test-node/wasm-worker-test.mjs
//
// Requires: npm install in test-node/ AND a patched dist/ (run build-wasm.sh or
// patch-node-bundle.mjs directly).

import { Worker } from 'node:worker_threads';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, '..', 'packages', 'duckdb-wasm', 'dist');

// ---------------------------------------------------------------------------
// Preflight
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
const SESSION_ID = 'test-session-abc123';

async function main() {
  console.log('--- Verifying NodeWorker export from main thread ---');
  const duckdb = await import('@run-trace/duckdb-wasm');
  assert(
    typeof duckdb.NodeWorker === 'function',
    'NodeWorker is exported from @run-trace/duckdb-wasm',
    `got: ${typeof duckdb.NodeWorker}`,
  );

  console.log('--- Spawning application worker thread with app-specific workerData ---');
  console.log(`  workerData: { sessionId: '${SESSION_ID}', config: { debug: false } }`);
  console.log('');

  const result = await new Promise((resolve) => {
    const w = new Worker(join(__dirname, 'wasm-worker-thread.mjs'), {
      workerData: {
        sessionId: SESSION_ID,
        config: { debug: false, env: 'test' },
      },
    });

    let settled = false;
    const settle = (msg) => { if (!settled) { settled = true; resolve(msg); } };

    w.on('message', settle);
    w.on('error', (err) => settle({ type: 'error', message: err.message, stack: err.stack }));
    w.on('exit', (code) => {
      if (code !== 0) settle({ type: 'error', message: `Worker exited with code ${code}` });
    });
  });

  console.log('--- Results ---');
  if (result.type === 'error') {
    console.log('  Worker error:', result.message);
  }

  assert(
    result.type === 'ok',
    'duckdb-wasm import succeeds in application worker thread',
    result.type === 'error' ? result.message : undefined,
  );
  assert(
    result.type === 'ok' && result.version.startsWith('v'),
    'DuckDB version query works inside worker thread',
    result.type === 'ok' ? `got: ${result.version}` : 'worker failed',
  );
  assert(
    result.type === 'ok' && result.hash === 'b640d6eba4e95e3a',
    'row_hash produces correct result inside worker thread',
    result.type === 'ok' ? `got: ${result.hash}` : 'worker failed',
  );
  assert(
    result.type === 'ok' && result.sessionId === SESSION_ID,
    'application workerData is preserved',
    result.type === 'ok' ? `got: ${result.sessionId}` : 'worker failed',
  );
  assert(
    result.type === 'ok' && result.globalClean === true,
    'global.postMessage not mutated by polyfill (He() did not run)',
    result.type === 'ok'
      ? 'He() ran — patch-node-bundle.mjs may not have been applied'
      : 'worker failed',
  );

  console.log('');
  console.log('========================================');
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('========================================');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
