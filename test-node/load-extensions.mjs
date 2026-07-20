#!/usr/bin/env node
// Run DuckDB Neo (@duckdb/node-api) with the extension directory set to
// <repo>/temp and LOAD each extension bundled in the duckdb-wasm package.
//
// Usage: node test-node/load-extensions.mjs

import { DuckDBInstance } from '@duckdb/node-api';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const EXT_DIR = join(REPO_ROOT, 'temp');

// Extensions bundled in the duckdb-wasm package (see lib/src/webdb.cc init calls).
const EXTENSIONS = ['json', 'parquet', 'icu', 'tpcds', 'tpch', 'fts', 'hash_ext', 'lua', 'quack'];

const instance = await DuckDBInstance.create(':memory:', {
  extension_directory: EXT_DIR,
  allow_unsigned_extensions: 'true',
});
const conn = await instance.connect();

console.log(`extension_directory: ${EXT_DIR}`);
console.log('');

for (const ext of EXTENSIONS) {
  try {
    await conn.run(`LOAD ${ext}`);
    console.log(`  loaded  ${ext}`);
  } catch (err) {
    console.log(`  FAILED  ${ext}: ${err.message}`);
  }
}
