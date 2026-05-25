#!/usr/bin/env node
// Patches dist/duckdb-node.cjs after the WASM build.
//
// Applies two fixes to the bundled web-worker polyfill:
//
// Patch 1 — Guard He() (the worker-side bootstrap) so it only runs when
//   workerData.mod is a string. Without this, importing @run-trace/duckdb-wasm
//   from an application worker thread (which has its own workerData) causes He()
//   to run, silently failing to load the DuckDB worker and mutating the global
//   object as a side effect (global.postMessage, prototype chain).
//
// Patch 2 — Export NodeWorker: the bundled Qe() Web Worker-compatible class.
//   With Patch 1 in place, Qe() is correctly returned in both main-thread and
//   worker-thread contexts, so a single NodeWorker export works everywhere in
//   Node.js without needing the 'web-worker' npm package.
//
// Both patches are idempotent: re-running is safe. The script exits non-zero if
// an anchor string is missing (meaning the bundle changed and the patch needs
// updating).

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'packages/duckdb-wasm/dist/duckdb-node.cjs');

let src;
try {
  src = readFileSync(TARGET, 'utf8');
} catch (err) {
  console.error(`ERROR: Could not read ${TARGET}`);
  console.error('Run the WASM build first: ./trace-scripts/build-wasm.sh');
  process.exit(1);
}

let changed = false;

// ---------------------------------------------------------------------------
// Patch 1: Guard He() — only run worker bootstrap when workerData.mod is set
// ---------------------------------------------------------------------------
const P1_BEFORE = 'le.exports=R.isMainThread?Qe():He()';
const P1_AFTER  = 'le.exports=R.isMainThread?Qe():(R.workerData&&typeof R.workerData.mod==="string"?He():Qe())';

if (src.includes(P1_AFTER)) {
  console.log('Patch 1 already applied.');
} else if (src.includes(P1_BEFORE)) {
  src = src.replace(P1_BEFORE, P1_AFTER);
  console.log('Patch 1 applied: He() guard for non-DuckDB worker contexts.');
  changed = true;
} else {
  console.error('ERROR: Patch 1 anchor not found in bundle. Bundle may have changed.');
  console.error(`Expected: ${P1_BEFORE}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Patch 2: Export NodeWorker — the bundled Web Worker-compatible class
// ---------------------------------------------------------------------------
const P2_BEFORE = 'createWorker:()=>Ye,';
const P2_AFTER  = 'createWorker:()=>Ye,NodeWorker:()=>ue.default,';

if (src.includes(P2_AFTER)) {
  console.log('Patch 2 already applied.');
} else if (src.includes(P2_BEFORE)) {
  src = src.replace(P2_BEFORE, P2_AFTER);
  console.log('Patch 2 applied: NodeWorker export added.');
  changed = true;
} else {
  console.error('ERROR: Patch 2 anchor not found in bundle. Bundle may have changed.');
  console.error(`Expected: ${P2_BEFORE}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Patch 3: Declare NodeWorker as a named variable for ESM export detection.
//   Node.js uses cjs-module-lexer to detect CJS named exports for dynamic
//   import(). The lexer requires shorthand variable syntax {Foo,Bar} in the
//   dead-code hint — it does not handle property-value expressions like
//   {NodeWorker:ue.default}. Declaring a real var gives us the shorthand.
// ---------------------------------------------------------------------------
const P3_BEFORE = 'var ue=f(de());async function Ye';
const P3_AFTER  = 'var ue=f(de());var NodeWorker=ue.default;async function Ye';

if (src.includes(P3_AFTER)) {
  console.log('Patch 3 already applied.');
} else if (src.includes(P3_BEFORE)) {
  src = src.replace(P3_BEFORE, P3_AFTER);
  console.log('Patch 3 applied: var NodeWorker declared.');
  changed = true;
} else {
  console.error('ERROR: Patch 3 anchor not found in bundle. Bundle may have changed.');
  console.error(`Expected: ${P3_BEFORE}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Patch 4: Add NodeWorker to the dead-code ESM named-export hint
//   Node.js uses `0&&(module.exports={...})` for static analysis of named
//   exports when a CJS module is imported via ESM dynamic import().
//   Must use shorthand {NodeWorker,...} — NodeWorker var declared in Patch 3.
// ---------------------------------------------------------------------------
const P4_BEFORE = '0&&(module.exports={AsyncDuckDB,';
const P4_AFTER  = '0&&(module.exports={NodeWorker,AsyncDuckDB,';

if (src.includes(P4_AFTER)) {
  console.log('Patch 4 already applied.');
} else if (src.includes(P4_BEFORE)) {
  src = src.replace(P4_BEFORE, P4_AFTER);
  console.log('Patch 4 applied: NodeWorker added to ESM named-export hint.');
  changed = true;
} else {
  console.error('ERROR: Patch 3 anchor not found in bundle. Bundle may have changed.');
  console.error(`Expected: ${P3_BEFORE}`);
  process.exit(1);
}

if (changed) {
  writeFileSync(TARGET, src, 'utf8');
  console.log(`Patched: ${TARGET}`);
} else {
  console.log('No changes needed.');
}
