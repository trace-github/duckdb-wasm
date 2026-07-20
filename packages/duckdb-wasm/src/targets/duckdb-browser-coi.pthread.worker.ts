import * as pthread_api from '../bindings/duckdb-coi.pthread';
import DuckDB from '../bindings/duckdb-coi';
import { BROWSER_RUNTIME } from '../bindings/runtime_browser';
import { installHTTPOptionsHooks, setHTTPOptions, HTTP_OPTIONS_PTHREAD_CMD } from '../bindings/http_options';

// trace fork: engine XHRs can execute on pthreads too — hook them here as
// well. The config arrives either at spawn time (bootstrap blob set by the
// wrapped Worker constructor) or via the HTTP_OPTIONS_PTHREAD_CMD broadcast
// handled below.
installHTTPOptionsHooks();

// Register the global DuckDB runtime
globalThis.DUCKDB_RUNTIME = {};
for (const func of Object.getOwnPropertyNames(BROWSER_RUNTIME)) {
    if (func == 'constructor') continue;
    globalThis.DUCKDB_RUNTIME[func] = Object.getOwnPropertyDescriptor(BROWSER_RUNTIME, func)!.value;
}

// trace fork: the Emscripten 4.x glue bundles the pthread bootstrap into the
// main module — calling DuckDB(m) below synchronously installs the glue's own
// handleMessage as self.onmessage, replacing this file's handler. Recapture it
// afterwards so the duckdb-specific commands (registerFileHandle & co,
// HTTP_OPTIONS_PTHREAD_CMD) stay handled here; everything else
// (run/checkMailbox/...) is forwarded to the glue's handler.
let emscriptenOnMessage: ((e: any) => void) | null = null;

const reclaimOnMessage = () => {
    const current = globalThis.onmessage as any;
    if (current === onDuckDBMessage) return;
    if (current) emscriptenOnMessage = current;
    globalThis.onmessage = onDuckDBMessage;
};

// We just override the load handler of the pthread wrapper to bundle DuckDB with esbuild.
const onDuckDBMessage = (e: any) => {
    if (e.data.cmd === 'load') {
        let m = pthread_api.getModule();

        (globalThis as any).startWorker = (instance: any) => {
            m = instance;
            postMessage({ cmd: 'loaded' });
        };
        m['wasmModule'] = e.data.wasmModule;
        m['wasmMemory'] = e.data.wasmMemory;
        m['buffer'] = m['wasmMemory'].buffer;
        m['ENVIRONMENT_IS_PTHREAD'] = true;
        const ready = DuckDB(m);
        reclaimOnMessage();
        ready.then((instance: any) => {
            pthread_api.setModule(instance);
            reclaimOnMessage();
        });
    } else if (e.data.cmd === 'registerFileHandle') {
        globalThis.DUCKDB_RUNTIME._files = globalThis.DUCKDB_RUNTIME._files || new Map();
        globalThis.DUCKDB_RUNTIME._files.set(e.data.fileName, e.data.fileHandle);
    } else if (e.data.cmd === 'dropFileHandle') {
        globalThis.DUCKDB_RUNTIME._files = globalThis.DUCKDB_RUNTIME._files || new Map();
        globalThis.DUCKDB_RUNTIME._files.delete(e.data.fileName);
    } else if (e.data.cmd === 'registerUDFFunction') {
        globalThis.DUCKDB_RUNTIME._udfFunctions = globalThis.DUCKDB_RUNTIME._files || new Map();
        globalThis.DUCKDB_RUNTIME._udfFunctions.set(e.data.udf.name, e.data.udf);
    } else if (e.data.cmd === 'dropUDFFunctions') {
        globalThis.DUCKDB_RUNTIME._udfFunctions = globalThis.DUCKDB_RUNTIME._files || new Map();
        for (const key of globalThis.DUCKDB_RUNTIME._udfFunctions.keys()) {
            if (globalThis.DUCKDB_RUNTIME._udfFunctions.get(key).connection_id == e.data.connectionId) {
                globalThis.DUCKDB_RUNTIME._udfFunctions.delete(key);
            }
        }
    } else if (e.data.cmd === HTTP_OPTIONS_PTHREAD_CMD) {
        // trace fork: config re-broadcast for pthreads spawned before open()
        setHTTPOptions(e.data.http ?? null);
    } else if (emscriptenOnMessage) {
        emscriptenOnMessage(e);
    } else {
        pthread_api.onmessage(e);
    }
};

globalThis.onmessage = onDuckDBMessage;
