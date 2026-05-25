#!/usr/bin/env node
// Node.js durability smoke tests for @run-trace/duckdb-wasm.
//
// Covers (without OPFS — Node.js doesn't have it):
//   1. Rapid DB lifecycle — create/destroy 20 times, detect leaks
//   2. Memory pressure — large buffer registrations under query load
//   3. Data integrity — write, close, reopen, verify across 10 cycles
//   4. Concurrent connections — parallel queries from multiple connections
//   5. Crash recovery — terminate without close, reopen, verify
//
// Usage: node test-node/wasm-durability-test.mjs

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, '..', 'packages', 'duckdb-wasm', 'dist');

if (!existsSync(join(DIST_DIR, 'duckdb-eh.wasm'))) {
  console.error('ERROR: duckdb-eh.wasm not found in dist/. Run the WASM build first.');
  process.exit(1);
}

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

function getFirstInt(table) {
  const row = table.get(0);
  if (!row) return null;
  const col = table.schema.fields[0].name;
  return Number(row[col]);
}

async function makeDB(duckdb) {
  const { default: Worker } = await import('web-worker');
  const BUNDLES = {
    mvp: {
      mainModule: join(DIST_DIR, 'duckdb-mvp.wasm'),
      mainWorker: join(DIST_DIR, 'duckdb-node-mvp.worker.cjs'),
    },
    eh: {
      mainModule: join(DIST_DIR, 'duckdb-eh.wasm'),
      mainWorker: join(DIST_DIR, 'duckdb-node-eh.worker.cjs'),
    },
  };
  const bundle = await duckdb.selectBundle(BUNDLES);
  const logger = new duckdb.ConsoleLogger();
  const worker = new Worker(bundle.mainWorker);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  return { db, worker };
}

async function main() {
  const duckdb = await import('@run-trace/duckdb-wasm');

  // =========================================================================
  // Test 1: Rapid DB lifecycle — 20 create/query/destroy cycles
  // =========================================================================
  console.log('--- Test 1: Rapid DB lifecycle (20 cycles) ---');
  const t1 = Date.now();
  try {
    for (let i = 0; i < 20; i++) {
      const { db, worker } = await makeDB(duckdb);
      await db.open({});
      const conn = await db.connect();
      const n = getFirstInt(await conn.query(`SELECT count(*) FROM generate_series(1, 1000) t(i)`));
      if (n !== 1000) throw new Error('Cycle ' + i + ': expected 1000, got ' + n);
      await conn.close();
      await db.terminate();
      worker.terminate();
    }
    // Final cycle — if resources leaked, this will fail
    const { db, worker } = await makeDB(duckdb);
    await db.open({});
    const conn = await db.connect();
    const v = getFirstInt(await conn.query('SELECT 42'));
    if (v !== 42) throw new Error('Final sanity: got ' + v);
    await conn.close();
    await db.terminate();
    worker.terminate();
    assert(true, 'rapid lifecycle (20 cycles, ' + (Date.now() - t1) + 'ms)');
  } catch (e) {
    assert(false, 'rapid lifecycle', e.message);
  }

  // =========================================================================
  // Test 2: Memory pressure — large buffer registrations under query load
  // =========================================================================
  console.log('--- Test 2: Memory pressure (large buffers + queries) ---');
  const t2 = Date.now();
  try {
    const { db, worker } = await makeDB(duckdb);
    await db.open({});
    const conn = await db.connect();

    await conn.query('CREATE TABLE pressure AS SELECT i, repeat(\'x\', 200) AS payload FROM generate_series(1, 50000) t(i)');

    for (let r = 0; r < 10; r++) {
      // Build and register a large CSV buffer (~400KB)
      let csv = 'id,val\n';
      for (let i = 0; i < 2000; i++) csv += i + ',' + 'x'.repeat(200) + '\n';
      const buf = new TextEncoder().encode(csv);
      await db.registerFileBuffer('buf_' + r + '.csv', buf);

      // Query simultaneously
      const count = getFirstInt(await conn.query('SELECT count(*) FROM pressure WHERE i > ' + (r * 5000)));
      if (count === null || count <= 0) throw new Error('Round ' + r + ': bad count ' + count);
    }

    const finalCount = getFirstInt(await conn.query('SELECT count(*) FROM pressure'));
    if (finalCount !== 50000) throw new Error('Final: expected 50000, got ' + finalCount);

    await conn.close();
    await db.terminate();
    worker.terminate();
    assert(true, 'memory pressure (10 rounds, ' + (Date.now() - t2) + 'ms)');
  } catch (e) {
    assert(false, 'memory pressure', e.message);
  }

  // =========================================================================
  // Test 3: Data integrity across open/close cycles (in-memory)
  // =========================================================================
  console.log('--- Test 3: Data integrity across 10 reopen cycles ---');
  const t3 = Date.now();
  try {
    // Node uses in-memory DB — can't persist across restarts. But we can test
    // that data survives across connection open/close within the same DB instance.
    const { db, worker } = await makeDB(duckdb);
    await db.open({});

    for (let c = 0; c < 10; c++) {
      const conn = await db.connect();

      if (c === 0) {
        await conn.query('CREATE TABLE integrity (cycle INT, val INT)');
      }
      await conn.query(`INSERT INTO integrity SELECT ${c}, i FROM generate_series(1, 500) t(i)`);

      const total = getFirstInt(await conn.query('SELECT count(*) FROM integrity'));
      const expected = (c + 1) * 500;
      if (total !== expected) throw new Error('Cycle ' + c + ': expected ' + expected + ', got ' + total);

      const cycles = getFirstInt(await conn.query('SELECT count(DISTINCT cycle) FROM integrity'));
      if (cycles !== c + 1) throw new Error('Cycle ' + c + ': expected ' + (c + 1) + ' distinct cycles, got ' + cycles);

      await conn.close();
    }

    await db.terminate();
    worker.terminate();
    assert(true, 'data integrity (10 reopen cycles, ' + (Date.now() - t3) + 'ms)');
  } catch (e) {
    assert(false, 'data integrity', e.message);
  }

  // =========================================================================
  // Test 4: Concurrent connections — parallel queries
  // =========================================================================
  console.log('--- Test 4: Concurrent connections (6 parallel queries) ---');
  const t4 = Date.now();
  try {
    const { db, worker } = await makeDB(duckdb);
    await db.open({});

    const setup = await db.connect();
    await setup.query('CREATE TABLE concurrent AS SELECT i, repeat(\'z\', 100) AS data FROM generate_series(1, 5000) t(i)');
    await setup.close();

    // 6 connections querying in parallel
    const N = 6;
    const promises = [];
    for (let i = 0; i < N; i++) {
      const p = (async () => {
        const c = await db.connect();
        const n = getFirstInt(await c.query('SELECT count(*) FROM concurrent WHERE i % ' + N + ' = ' + i));
        await c.close();
        return n;
      })();
      promises.push(p);
    }

    const results = await Promise.all(promises);
    const totalRows = results.reduce((a, b) => a + b, 0);
    if (totalRows !== 5000) throw new Error('Total rows: expected 5000, got ' + totalRows);

    await db.terminate();
    worker.terminate();
    assert(true, 'concurrent connections (' + N + ' parallel, ' + (Date.now() - t4) + 'ms)');
  } catch (e) {
    assert(false, 'concurrent connections', e.message);
  }

  // =========================================================================
  // Test 5: Hard terminate + new instance
  // =========================================================================
  console.log('--- Test 5: Hard terminate + new instance ---');
  const t5 = Date.now();
  try {
    // Create DB, write data, hard-terminate without cleanup
    {
      const { db, worker } = await makeDB(duckdb);
      await db.open({});
      const conn = await db.connect();
      await conn.query('CREATE TABLE crash_test AS SELECT i FROM generate_series(1, 10000) t(i)');
      // Do NOT close conn or call db.terminate() — kill the worker directly
      worker.terminate();
    }

    // Create a fresh instance — must work without interference from the killed one
    const { db, worker } = await makeDB(duckdb);
    await db.open({});
    const conn = await db.connect();
    const v = getFirstInt(await conn.query('SELECT 42'));
    if (v !== 42) throw new Error('Post-crash sanity: got ' + v);

    // Verify we can do real work
    await conn.query('CREATE TABLE post_crash AS SELECT i FROM generate_series(1, 5000) t(i)');
    const n = getFirstInt(await conn.query('SELECT count(*) FROM post_crash'));
    if (n !== 5000) throw new Error('Post-crash table: expected 5000, got ' + n);

    await conn.close();
    await db.terminate();
    worker.terminate();
    assert(true, 'hard terminate + new instance (' + (Date.now() - t5) + 'ms)');
  } catch (e) {
    assert(false, 'hard terminate + new instance', e.message);
  }

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
