import DuckDBWasm from './duckdb-coi.js';
import { DuckDBBrowserBindings } from './bindings_browser_base';
import { DuckDBModule } from './duckdb_module';
import { DuckDBRuntime } from './runtime';
import { Logger } from '../log';

/** DuckDB bindings for the browser */
export class DuckDB extends DuckDBBrowserBindings {
    /** Constructor */
    public constructor(
        logger: Logger,
        runtime: DuckDBRuntime,
        mainModuleURL: string,
        pthreadWorkerURL: string | null = null,
    ) {
        super(logger, runtime, mainModuleURL, pthreadWorkerURL);
    }

    /** Instantiate the bindings */
    protected instantiateImpl(moduleOverrides: Partial<DuckDBModule>): Promise<DuckDBModule> {
        const opts: any = {
            ...moduleOverrides,
            instantiateWasm: this.instantiateWasm.bind(this),
            locateFile: this.locateFile.bind(this),
        };
        // Emscripten 4.0.3 uses mainScriptUrlOrBlob (not locateFile) for pthread workers
        if (this.pthreadWorkerURL) {
            opts.mainScriptUrlOrBlob = this.pthreadWorkerURL;
        }
        return DuckDBWasm(opts);
    }
}

export default DuckDB;
