export * from '../bindings';
export * from '../log';
export * from '../platform';
export * from '../status';
export * from '../version';
export { DuckDBDataProtocol } from '../bindings/runtime';
export { DEFAULT_RUNTIME } from '../bindings/runtime';
export { BROWSER_RUNTIME } from '../bindings/runtime_browser';

import { Logger } from '../log';
import { DuckDBRuntime, DuckDBBindings } from '../bindings';
import { DuckDBBundles } from '../platform';
import { DuckDB as DuckDBEH } from '../bindings/bindings_browser_eh';

export async function createDuckDB(
    bundles: DuckDBBundles,
    logger: Logger,
    runtime: DuckDBRuntime,
): Promise<DuckDBBindings> {
    const module = bundles.eh ?? bundles.mvp;
    if (!module) {
        throw new Error('No suitable DuckDB bundle found');
    }
    return new DuckDBEH(logger, runtime, module.mainModule);
}
