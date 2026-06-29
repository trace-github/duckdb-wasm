// Worker entry that injects a synchronous XMLHttpRequest (Node lacks one) before
// loading DuckDB-WASM's node worker, so the wasm quack client can do HTTP.
// In a browser this whole file is unnecessary — XMLHttpRequest is native.
globalThis.XMLHttpRequest = require('./sync-xhr-node.cjs');
require('../packages/duckdb-wasm/dist/duckdb-node-eh.worker.cjs');

