# @run-trace/duckdb-wasm

Fork of [duckdb/duckdb-wasm](https://github.com/duckdb/duckdb-wasm) with statically linked extensions and a Node.js worker thread fix.

For general DuckDB-Wasm documentation, see the [upstream README](https://github.com/duckdb/duckdb-wasm).

## What we changed

### Bundled extensions

Extensions are statically linked — no runtime installation or network fetch needed:

| Extension | Type |
|-----------|------|
| json | DuckDB built-in |
| parquet | DuckDB built-in |
| icu | DuckDB built-in |
| tpcds | DuckDB built-in |
| tpch | DuckDB built-in |
| fts | External ([duckdb-fts](https://github.com/duckdb/duckdb-fts)) |
| lua | External ([duckdb-lua](https://github.com/isaacbrodsky/duckdb-lua)) |
| hash_ext | Custom Rust — `row_hash(col, ...)` stable 64-bit hashing |

### Package rename

Published as `@run-trace/duckdb-wasm` instead of `@duckdb/duckdb-wasm`. Zero TypeScript/JavaScript source changes.

### Node.js worker thread fix

The upstream bundle includes a web-worker polyfill that mutates `global.postMessage` when imported from a `worker_threads` worker with custom `workerData`. We apply a post-build patch to `dist/duckdb-node.cjs` that:

1. Guards `He()` so it only runs when `workerData.mod` is a string (i.e., only for DuckDB's own internal workers, not application workers)
2. Exports `NodeWorker` — the bundled Worker class — so you can use identical code in any Node.js context without the `web-worker` npm package

The patch is applied automatically by `build-wasm.sh` via `trace-scripts/patch-node-bundle.mjs`. The `dist/` directory is not tracked in git.

## Installation

```bash
npm install @run-trace/duckdb-wasm
```

No additional dependencies needed for Node.js — the `web-worker` polyfill is bundled.

## Usage

### Browser

Copy the WASM and worker files from `node_modules/@run-trace/duckdb-wasm/dist/` to your static assets directory, then:

```js
import * as duckdb from '@run-trace/duckdb-wasm';

const BUNDLES = {
  mvp: { mainModule: '/assets/duckdb-mvp.wasm',  mainWorker: '/assets/duckdb-browser-mvp.worker.js' },
  eh:  { mainModule: '/assets/duckdb-eh.wasm',   mainWorker: '/assets/duckdb-browser-eh.worker.js' },
};

const bundle = await duckdb.selectBundle(BUNDLES);
const worker = await duckdb.createWorker(bundle.mainWorker);
const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
await db.instantiate(bundle.mainModule);
await db.open({});

const conn = await db.connect();
const result = await conn.query("SELECT row_hash('user1', 'hello') AS h");
```

### Node.js (main thread)

```js
import * as duckdb from '@run-trace/duckdb-wasm';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// Resolve the dist/ directory inside the installed package
const require = createRequire(import.meta.url);
const DIST = dirname(require.resolve('@run-trace/duckdb-wasm/dist/duckdb-node.cjs'));

const BUNDLES = {
  mvp: { mainModule: join(DIST, 'duckdb-mvp.wasm'),  mainWorker: join(DIST, 'duckdb-node-mvp.worker.cjs') },
  eh:  { mainModule: join(DIST, 'duckdb-eh.wasm'),   mainWorker: join(DIST, 'duckdb-node-eh.worker.cjs') },
};

const bundle = await duckdb.selectBundle(BUNDLES);
const worker = new duckdb.NodeWorker(bundle.mainWorker);  // no web-worker package needed
const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
await db.instantiate(bundle.mainModule);
await db.open({});

const conn = await db.connect();
const result = await conn.query("SELECT version() AS v");
console.log(result.get(0).v);  // v1.5.2

await conn.close();
await db.terminate();
worker.terminate();
```

### Node.js (worker thread)

`NodeWorker` works identically inside a `worker_threads` worker — no adapter, no `web-worker` package, no global mutation:

```js
// app-worker.mjs — spawned with: new Worker('./app-worker.mjs', { workerData: { sessionId: '...' } })
import * as duckdb from '@run-trace/duckdb-wasm';
import { workerData, parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const DIST = dirname(require.resolve('@run-trace/duckdb-wasm/dist/duckdb-node.cjs'));

const BUNDLES = {
  mvp: { mainModule: join(DIST, 'duckdb-mvp.wasm'),  mainWorker: join(DIST, 'duckdb-node-mvp.worker.cjs') },
  eh:  { mainModule: join(DIST, 'duckdb-eh.wasm'),   mainWorker: join(DIST, 'duckdb-node-eh.worker.cjs') },
};

const bundle = await duckdb.selectBundle(BUNDLES);
const worker = new duckdb.NodeWorker(bundle.mainWorker);  // same API as main thread
const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
await db.instantiate(bundle.mainModule);
await db.open({});

const conn = await db.connect();
const result = await conn.query("SELECT row_hash('user1', 'hello') AS h");
parentPort.postMessage({ hash: String(result.get(0).h) });

// Your workerData is untouched — DuckDB's polyfill doesn't run in this context
console.log(workerData.sessionId);

await conn.close();
await db.terminate();
worker.terminate();
```

## Building

Requires Docker (for WASM) and Rust (for native extensions).

```bash
./trace-scripts/build-wasm.sh          # WASM build (Docker) — patches duckdb-node.cjs automatically
./extensions/hash_ext/build-all.sh     # Native hash_ext for all 4 platforms
./trace-scripts/run-tests.sh           # All tests
./trace-scripts/clean.sh --all         # Full clean
```

## Testing

All suites must pass before publishing:

- **Browser smoke** — DuckDB loads, version matches, JSON/Parquet work
- **Browser hash-ext** — All hash function tests pass
- **Browser lua** — All lua tests pass
- **Node.js WASM smoke** — DuckDB loads via `NodeWorker`, queries and bundled extensions work
- **Node.js WASM worker thread** — DuckDB works inside an application `worker_threads` worker; `global.postMessage` not mutated; `NodeWorker` exported and functional
- **Node.js native extension** — `hash_ext` loads via `@duckdb/node-api`, known hash values match

## Skills (for Claude Code)

- **Upgrading DuckDB version**: `.claude/skills/upgrade-duckdb-wasm/`
- **Committing and publishing**: `.claude/skills/commit-and-publish-duckdb-wasm/`
