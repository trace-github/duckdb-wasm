#!/usr/bin/env node
// Smoke test for hash_ext native extension using @duckdb/node-api
//
// Usage: node test-node/smoke-test.mjs
//
// Expects the native extension to be pre-built in extension-dist/.
// Run extensions/hash_ext/build.sh first.

import { DuckDBInstance } from '@duckdb/node-api';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Detect platform and find extension
// ---------------------------------------------------------------------------
function detectPlatform() {
  const os = process.platform === 'darwin' ? 'osx' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  return `${os}_${arch}`;
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
  const platform = detectPlatform();
  console.log(`Platform: ${platform}`);

  // Find extension
  const distDir = join(ROOT, 'extension-dist');
  if (!existsSync(distDir)) {
    console.error('ERROR: extension-dist/ not found. Run extensions/hash_ext/build.sh first.');
    process.exit(1);
  }

  const versions = readdirSync(distDir).filter(d => d.startsWith('v'));
  if (versions.length === 0) {
    console.error('ERROR: no version directories in extension-dist/');
    process.exit(1);
  }
  versions.sort();
  const version = versions[versions.length - 1];
  const extDir = join(distDir, version, platform);

  const extFile = join(extDir, 'hash_ext.duckdb_extension');
  if (!existsSync(extFile)) {
    console.error(`ERROR: ${extFile} not found. Run extensions/hash_ext/build.sh first.`);
    process.exit(1);
  }

  console.log(`Extension: ${extFile}`);
  console.log('');

  // Create DuckDB instance with unsigned extensions allowed
  const instance = await DuckDBInstance.create(':memory:', {
    allow_unsigned_extensions: 'true',
  });
  const conn = await instance.connect();

  // Load extension
  console.log('Loading hash_ext extension...');
  await conn.run(`LOAD '${extFile}'`);
  console.log('Extension loaded.');
  console.log('');

  // --- Test 1: row_hash known value ---
  console.log('--- row_hash ---');
  const r1 = await conn.runAndReadAll("SELECT row_hash('user1', 'hello') AS h");
  const h1 = r1.getRows()[0][0];
  assert(h1 === 'b640d6eba4e95e3a', 'row_hash known value', `got ${h1}`);

  // --- Test 2: row_hash determinism ---
  const r2 = await conn.runAndReadAll("SELECT row_hash('a', 'b') AS h1, row_hash('a', 'b') AS h2");
  const row2 = r2.getRows()[0];
  assert(row2[0] === row2[1], 'row_hash determinism');

  // --- Test 3: hash_json ---
  console.log('--- hash_json ---');
  const r3 = await conn.runAndReadAll(`SELECT hash_json('{"x":1}', 'x') AS h`);
  const h3 = r3.getRows()[0][0];
  assert(h3 !== null && h3 !== undefined, 'hash_json returns non-null', `got ${h3}`);

  // --- Test 4: hash_json_keys ---
  console.log('--- hash_json_keys ---');
  const r4 = await conn.runAndReadAll(`SELECT hash_json_keys(['a','b'], '{"a":1,"b":2}') AS h`);
  const h4 = r4.getRows()[0][0];
  assert(h4 !== null && h4 !== undefined, 'hash_json_keys returns non-null', `got ${h4}`);

  // --- Test 5: hash_table table function ---
  console.log('--- hash_table ---');
  const r5 = await conn.runAndReadAll(`
    SELECT * FROM hash_table(
      (SELECT 'id1' AS id, 'val1' AS value UNION ALL SELECT 'id2', 'val2')
    )
  `);
  const rows5 = r5.getRows();
  assert(rows5.length === 2, 'hash_table returns 2 rows', `got ${rows5.length}`);

  // --- Test 6: metric_table table function ---
  console.log('--- metric_table ---');
  const r6 = await conn.runAndReadAll(`
    SELECT * FROM metric_table(
      (SELECT '{"env":"prod","host":"h1"}' AS vals, 42.0 AS value, 1 AS count),
      'env',
      ['env'],
      'host'
    )
  `);
  const rows6 = r6.getRows();
  assert(rows6.length === 1, 'metric_table returns 1 row', `got ${rows6.length}`);

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
