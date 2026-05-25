import * as check from 'wasm-feature-detect';
import { PACKAGE_NAME, PACKAGE_VERSION } from './version';

// Platform check taken from here:
// https://github.com/xtermjs/xterm.js/blob/master/src/common/Platform.ts#L21

interface INavigator {
    userAgent: string;
    language: string;
    platform: string;
}

// We're declaring a navigator global here as we expect it in all runtimes (node and browser), but
// we want this module to live in common.
declare const navigator: INavigator;

export const isNode = () => (typeof navigator === 'undefined' ? true : false);
const userAgent = () => (isNode() ? 'node' : navigator.userAgent);
export const isFirefox = () => userAgent().includes('Firefox');
export const isSafari = () => /^((?!chrome|android).)*safari/i.test(userAgent());

/** Bundles have different characteristics:
 * - MVP: minimum viable product (uses features from first stable version of WebAssembly standard)
 * - EH: exception handling
 * - COI: cross origin isolation
 */
export interface DuckDBBundles {
    mvp?: {
        mainModule: string;
        mainWorker: string;
    };
    eh?: {
        mainModule: string;
        mainWorker: string;
    };
    coi?: {
        mainModule: string;
        mainWorker: string;
        pthreadWorker: string;
    };
}

export function getJsDelivrBundles(): DuckDBBundles {
    const jsdelivr_dist_url = `https://cdn.jsdelivr.net/npm/${PACKAGE_NAME}@${PACKAGE_VERSION}/dist/`;
    return {
        eh: {
            mainModule: `${jsdelivr_dist_url}duckdb-eh.wasm`,
            mainWorker: `${jsdelivr_dist_url}duckdb-browser-eh.worker.js`,
        },
        coi: {
            mainModule: `${jsdelivr_dist_url}duckdb-coi.wasm`,
            mainWorker: `${jsdelivr_dist_url}duckdb-browser-coi.worker.js`,
            pthreadWorker: `${jsdelivr_dist_url}duckdb-browser-coi.pthread.worker.js`,
        },
    };
}

export interface DuckDBBundle {
    mainModule: string;
    mainWorker: string | null;
    pthreadWorker: string | null;
}

export interface PlatformFeatures {
    bigInt64Array: boolean;
    crossOriginIsolated: boolean;
    wasmExceptions: boolean;
    wasmSIMD: boolean;
    wasmBulkMemory: boolean;
    wasmThreads: boolean;
}

let bigInt64Array: boolean | null = null;
let wasmExceptions: boolean | null = null;
let wasmThreads: boolean | null = null;
let wasmSIMD: boolean | null = null;
let wasmBulkMemory: boolean | null = null;

// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace globalThis {
    let crossOriginIsolated: boolean;
}

export async function getPlatformFeatures(): Promise<PlatformFeatures> {
    if (bigInt64Array == null) {
        bigInt64Array = typeof BigInt64Array != 'undefined';
    }
    if (wasmExceptions == null) {
        wasmExceptions = await check.exceptions();
    }
    if (wasmThreads == null) {
        wasmThreads = await check.threads();
    }
    if (wasmSIMD == null) {
        wasmSIMD = await check.simd();
    }
    if (wasmBulkMemory == null) {
        wasmBulkMemory = await check.bulkMemory();
    }
    return {
        bigInt64Array: bigInt64Array!,
        crossOriginIsolated: isNode() || globalThis.crossOriginIsolated || false,
        wasmExceptions: wasmExceptions!,
        wasmSIMD: wasmSIMD!,
        wasmThreads: wasmThreads!,
        wasmBulkMemory: wasmBulkMemory!,
    };
}

export async function selectBundle(bundles: DuckDBBundles): Promise<DuckDBBundle> {
    const platform = await getPlatformFeatures();
    if (platform.wasmExceptions) {
        if (platform.wasmSIMD && platform.wasmThreads && platform.crossOriginIsolated && bundles.coi) {
            return {
                mainModule: bundles.coi.mainModule,
                mainWorker: bundles.coi.mainWorker,
                pthreadWorker: bundles.coi.pthreadWorker,
            };
        }
        if (bundles.eh) {
            return {
                mainModule: bundles.eh.mainModule,
                mainWorker: bundles.eh.mainWorker,
                pthreadWorker: null,
            };
        }
    }
    const fallback = bundles.mvp ?? bundles.eh;
    if (!fallback) {
        throw new Error('No suitable DuckDB bundle found for this platform');
    }
    return {
        mainModule: fallback.mainModule,
        mainWorker: fallback.mainWorker,
        pthreadWorker: null,
    };
}
