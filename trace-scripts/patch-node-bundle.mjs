#!/usr/bin/env node
// Patches dist/duckdb-node.cjs after the WASM build.
//
// Applies fixes to the bundled web-worker polyfill so that:
//   - Importing @run-trace/duckdb-wasm from an application worker thread
//     doesn't trigger the DuckDB worker bootstrap or mutate globals.
//   - NodeWorker is exported for use without the 'web-worker' npm package.
//
// All patches use regex patterns that match the code structure rather than
// exact minified variable names, so they survive esbuild minification changes.
//
// All patches are idempotent: re-running is safe.

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
// Patch 1: Guard the worker bootstrap function
//
// esbuild produces: <mod>.exports=<R>.isMainThread?<Qe>():<He>()
// We change it to only call the bootstrap (<He>) when workerData.mod is a
// string (meaning DuckDB spawned this worker), otherwise return the main-
// thread class (<Qe>) so the import is safe from application workers.
//
// Regex matches: <var>.exports=<var>.isMainThread?<fn>():<fn>()
// ---------------------------------------------------------------------------
const P1_GUARD = '.workerData&&typeof';
if (src.includes(P1_GUARD)) {
  console.log('Patch 1 already applied.');
} else {
  // Match: <x>.exports=<R>.isMainThread?<Qe>():<He>()
  const p1re = /(\w+\.exports\s*=\s*(\w+)\.isMainThread\s*\?\s*(\w+)\(\)\s*:\s*)(\w+)\(\)/;
  const m1 = src.match(p1re);
  if (m1) {
    const [full, prefix, threadsMod, mainFn, workerFn] = m1;
    const replacement = `${prefix}(${threadsMod}.workerData&&typeof ${threadsMod}.workerData.mod==="string"?${workerFn}():${mainFn}())`;
    src = src.replace(full, replacement);
    console.log(`Patch 1 applied: guarded ${workerFn}() with workerData.mod check.`);
    changed = true;
  } else {
    console.error('ERROR: Patch 1 — could not find isMainThread ternary pattern.');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Patch 2: Export NodeWorker in the CJS exports object
//
// esbuild produces: createWorker:()=><Ye>,
// We add:           NodeWorker:()=><ue>.default,
//
// We need to find the web-worker polyfill variable name. It's the result of
// calling the lazy require wrapper: var <ue> = <wrapper>(<lazyRequire>())
// right before an async function definition.
// ---------------------------------------------------------------------------
const P2_GUARD = 'NodeWorker:()=>';
if (src.includes(P2_GUARD)) {
  console.log('Patch 2 already applied.');
} else {
  // Find the web-worker polyfill variable: var <X> = <fn>(<fn>());
  // This is the only var=fn(fn()) followed by async function in the bundle.
  const webWorkerVarRe = /var (\w+)=\w+\(\w+\(\)\);(?:var NodeWorker=\w+\.default;)?async function/;
  const mWW = src.match(webWorkerVarRe);
  if (!mWW) {
    console.error('ERROR: Patch 2 — could not find web-worker polyfill variable.');
    process.exit(1);
  }
  const polyfillVar = mWW[1]; // e.g. "ue"

  const createWorkerRe = /createWorker:\(\)=>\w+,/;
  const mCW = src.match(createWorkerRe);
  if (mCW) {
    src = src.replace(mCW[0], `${mCW[0]}NodeWorker:()=>${polyfillVar}.default,`);
    console.log(`Patch 2 applied: NodeWorker export added (polyfill var: ${polyfillVar}).`);
    changed = true;
  } else {
    console.error('ERROR: Patch 2 — could not find createWorker export.');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Patch 3: Declare a real NodeWorker variable for CJS named-export detection
//
// Node.js uses cjs-module-lexer to detect named exports from CJS modules.
// The lexer needs shorthand {NodeWorker} in the dead-code hint, which
// requires a real variable (not a property expression like ue.default).
//
// We insert: var NodeWorker=<polyfillVar>.default;
// before the async function that follows the web-worker import.
// ---------------------------------------------------------------------------
const P3_GUARD = 'var NodeWorker=';
if (src.includes(P3_GUARD)) {
  console.log('Patch 3 already applied.');
} else {
  const webWorkerVarRe = /var (\w+)=(\w+\(\w+\(\)\));(async function)/;
  const m3 = src.match(webWorkerVarRe);
  if (m3) {
    const [full, polyfillVar, requireExpr, asyncFn] = m3;
    const replacement = `var ${polyfillVar}=${requireExpr};var NodeWorker=${polyfillVar}.default;${asyncFn}`;
    src = src.replace(full, replacement);
    console.log(`Patch 3 applied: var NodeWorker declared.`);
    changed = true;
  } else {
    console.error('ERROR: Patch 3 — could not find web-worker var pattern.');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Patch 4: Add NodeWorker to the dead-code ESM named-export hint
//
// esbuild emits: 0&&(module.exports={AsyncDuckDB,...})
// We prepend NodeWorker to the list.
// ---------------------------------------------------------------------------
const P4_ANCHOR = '0&&(module.exports={';
const P4_PATCHED = '0&&(module.exports={NodeWorker,';
if (src.includes(P4_PATCHED)) {
  console.log('Patch 4 already applied.');
} else if (src.includes(P4_ANCHOR)) {
  src = src.replace(P4_ANCHOR, P4_PATCHED);
  console.log('Patch 4 applied: NodeWorker added to ESM named-export hint.');
  changed = true;
} else {
  console.error('ERROR: Patch 4 — could not find 0&&(module.exports={ pattern.');
  process.exit(1);
}

if (changed) {
  writeFileSync(TARGET, src, 'utf8');
  console.log(`Patched: ${TARGET}`);
} else {
  console.log('No changes needed.');
}
