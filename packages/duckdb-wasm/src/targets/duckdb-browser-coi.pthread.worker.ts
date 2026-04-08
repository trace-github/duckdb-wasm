import * as pthread_api from '../bindings/duckdb-coi.pthread';
import { BROWSER_RUNTIME } from '../bindings/runtime_browser';

// Register the global DuckDB runtime
globalThis.DUCKDB_RUNTIME = {};
for (const func of Object.getOwnPropertyNames(BROWSER_RUNTIME)) {
    if (func == 'constructor') continue;
    globalThis.DUCKDB_RUNTIME[func] = Object.getOwnPropertyDescriptor(BROWSER_RUNTIME, func)!.value;
}

// In Emscripten 4.x, duckdb-coi.pthread.js requires duckdb-coi.js which sets
// self.onmessage synchronously in pthread mode (ENVIRONMENT_IS_PTHREAD=true).
// pthread_api.onmessage captures that handler.
const emscriptenOnMessage = pthread_api.onmessage;

// DuckDB-specific message handler installed after pthread init completes.
const duckdbOnMessage = (e: any) => {
    if (e.data.cmd === 'registerFileHandle') {
        globalThis.DUCKDB_RUNTIME._files = globalThis.DUCKDB_RUNTIME._files || new Map();
        globalThis.DUCKDB_RUNTIME._files.set(e.data.fileName, e.data.fileHandle);
    } else if (e.data.cmd === 'dropFileHandle') {
        globalThis.DUCKDB_RUNTIME._files = globalThis.DUCKDB_RUNTIME._files || new Map();
        globalThis.DUCKDB_RUNTIME._files.delete(e.data.fileName);
    } else if (e.data.cmd === 'registerUDFFunction') {
        globalThis.DUCKDB_RUNTIME._udfFunctions = globalThis.DUCKDB_RUNTIME._udfFunctions || new Map();
        globalThis.DUCKDB_RUNTIME._udfFunctions.set(e.data.udf.name, e.data.udf);
    } else if (e.data.cmd === 'dropUDFFunctions') {
        globalThis.DUCKDB_RUNTIME._udfFunctions = globalThis.DUCKDB_RUNTIME._udfFunctions || new Map();
        for (const key of globalThis.DUCKDB_RUNTIME._udfFunctions.keys()) {
            if (globalThis.DUCKDB_RUNTIME._udfFunctions.get(key).connection_id == e.data.connectionId) {
                globalThis.DUCKDB_RUNTIME._udfFunctions.delete(key);
            }
        }
    } else {
        emscriptenOnMessage?.(e);
    }
};

globalThis.onmessage = (e: any) => {
    if (e.data.cmd === 'load') {
        // Forward to Emscripten's load handler, which:
        //   1. Sets self.startWorker (synchronously)
        //   2. Calls wasmModuleReceived(wasmModule) to trigger WASM instantiation
        // We override startWorker after this call (before WASM instantiation completes)
        // to capture the module instance and re-register our message handler.
        emscriptenOnMessage?.(e);
        const emOrigStart = (globalThis as any).startWorker;
        (globalThis as any).startWorker = (instance: any) => {
            pthread_api.setModule(instance);
            emOrigStart?.(instance);
            // Emscripten's startWorker restores self.onmessage = handleMessage;
            // re-register our handler on top of it.
            globalThis.onmessage = duckdbOnMessage;
        };
    } else {
        duckdbOnMessage(e);
    }
};