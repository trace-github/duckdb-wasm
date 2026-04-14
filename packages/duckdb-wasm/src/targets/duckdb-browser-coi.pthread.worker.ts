import * as pthread_api from '../bindings/duckdb-coi.pthread';
import { BROWSER_RUNTIME } from '../bindings/runtime_browser';

// Register the global DuckDB runtime before any Emscripten wasm instantiation
globalThis.DUCKDB_RUNTIME = {};
for (const func of Object.getOwnPropertyNames(BROWSER_RUNTIME)) {
    if (func == 'constructor') continue;
    globalThis.DUCKDB_RUNTIME[func] = Object.getOwnPropertyDescriptor(BROWSER_RUNTIME, func)!.value;
}

// Handle DuckDB-specific worker commands. Returns true if handled.
function handleDuckDBCommand(e: any): boolean {
    switch (e.data.cmd) {
        case 'registerFileHandle':
            globalThis.DUCKDB_RUNTIME._files = globalThis.DUCKDB_RUNTIME._files || new Map();
            globalThis.DUCKDB_RUNTIME._files.set(e.data.fileName, e.data.fileHandle);
            return true;
        case 'dropFileHandle':
            globalThis.DUCKDB_RUNTIME._files = globalThis.DUCKDB_RUNTIME._files || new Map();
            globalThis.DUCKDB_RUNTIME._files.delete(e.data.fileName);
            return true;
        case 'registerUDFFunction':
            globalThis.DUCKDB_RUNTIME._udfFunctions = globalThis.DUCKDB_RUNTIME._udfFunctions || new Map();
            globalThis.DUCKDB_RUNTIME._udfFunctions.set(e.data.udf.name, e.data.udf);
            return true;
        case 'dropUDFFunctions':
            globalThis.DUCKDB_RUNTIME._udfFunctions = globalThis.DUCKDB_RUNTIME._udfFunctions || new Map();
            for (const key of globalThis.DUCKDB_RUNTIME._udfFunctions.keys()) {
                if (globalThis.DUCKDB_RUNTIME._udfFunctions.get(key).connection_id == e.data.connectionId) {
                    globalThis.DUCKDB_RUNTIME._udfFunctions.delete(key);
                }
            }
            return true;
        default:
            return false;
    }
}

// The auto-init (isPthread && DuckDB()) ran during module load and set
// self.onmessage = handleMessage. The pthread stub captured that as
// pthread_api.onmessage. We override onmessage to forward 'load' to
// Emscripten's handler and wrap startWorker to capture the module instance,
// while also handling DuckDB-specific commands.
globalThis.onmessage = (e: any) => {
    if (e.data.cmd === 'load') {
        // Forward to Emscripten's handler which calls wasmModuleReceived()
        // to resolve createWasm() and proceed with initialization
        pthread_api.onmessage(e);

        // Emscripten's load handler set self.startWorker; wrap it to capture
        // the DuckDB module instance and re-register our command handlers
        const emStartWorker = (globalThis as any).startWorker;
        (globalThis as any).startWorker = (instance: any) => {
            pthread_api.setModule(instance);
            emStartWorker(instance);
            // After Emscripten's startWorker, self.onmessage is Emscripten's
            // handleMessage. Wrap it to also handle DuckDB-specific commands.
            const emOnMessage = self.onmessage;
            self.onmessage = (e2: any) => {
                if (!handleDuckDBCommand(e2)) {
                    emOnMessage!.call(self, e2);
                }
            };
        };
    } else if (!handleDuckDBCommand(e)) {
        pthread_api.onmessage(e);
    }
};
