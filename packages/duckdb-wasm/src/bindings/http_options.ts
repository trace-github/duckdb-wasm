// trace fork: opt-in HTTP options (cookies + extra headers) for engine XHRs.
//
// DuckDB-Wasm issues engine HTTP requests via synchronous XMLHttpRequest from
// two code paths that both end up compiled into the browser worker bundles:
//   - the EM_ASM blocks from lib/src/http_wasm.cc (quack client, built-in
//     httpfs) — plain JavaScript emitted by Emscripten, outside TypeScript's
//     reach
//   - runtime_browser.ts (read_parquet('https://...') and friends)
// Hooking XMLHttpRequest.prototype covers both without forking the C++.
//
// Config transport: the worker dispatcher lifts `http` off the OPEN config
// (setHTTPOptions). COI pthread workers spawned before OPEN get the config
// re-broadcast as a {cmd: HTTP_OPTIONS_PTHREAD_CMD} message (handled in
// duckdb-browser-coi.pthread.worker.ts); pthreads spawned later inherit it at
// spawn time via the wrapped Worker constructor below. The value lives on
// globalThis[HTTP_OPTIONS_GLOBAL] and is read lazily on every request, so a
// blob-importScripts worker bootstrap may also set it directly (low-level
// alternative to db.open({ http })). Config must be JSON-serializable.
//
// Cookies/CORS: withCredentials only matters cross-origin, and the server
// must respond with Access-Control-Allow-Origin: <exact origin> (not "*")
// plus Access-Control-Allow-Credentials: true, or the browser rejects the
// response. Custom headers additionally require the server to allow them in
// the OPTIONS preflight. Headers are appended, not replaced.

import { DuckDBHTTPConfig } from './config';

/** Global key holding the active config inside a (worker) scope */
export const HTTP_OPTIONS_GLOBAL = '__DUCKDB_HTTP__';
/** Worker message cmd used to propagate the config to running pthreads */
export const HTTP_OPTIONS_PTHREAD_CMD = '__duckdb_http__';

/** Workers spawned in this scope (COI pthreads), for config re-broadcast */
const spawnedWorkers = new Set<Worker>();

/** Read the active config (lazily, per request) */
export function getHTTPOptions(): DuckDBHTTPConfig | null {
    try {
        return ((globalThis as any)[HTTP_OPTIONS_GLOBAL] as DuckDBHTTPConfig) ?? null;
    } catch (_e) {
        return null;
    }
}

/** Store the active config and re-broadcast it to running pthread workers */
export function setHTTPOptions(config: DuckDBHTTPConfig | null): void {
    (globalThis as any)[HTTP_OPTIONS_GLOBAL] = config ?? undefined;
    for (const worker of spawnedWorkers) {
        try {
            worker.postMessage({ cmd: HTTP_OPTIONS_PTHREAD_CMD, http: config });
        } catch (_e) {
            // worker may already be terminated
        }
    }
}

// Pattern matching for withCredentials allowlist entries and headers keys.
// A pattern with no "*" is a literal prefix (url.startsWith) — the original
// behavior, kept for backward compatibility. A pattern containing "*" is a
// glob compiled to a start-anchored (prefix-style, not end-anchored) RegExp:
//   *   matches any run of characters except "/"  ([^/]*)
//   **  matches any run of characters including "/" (.*)
// "*" is deliberately slash-bounded so path/query content can't trick a host
// pattern into matching (e.g. "https://*.trace.dev" won't match
// "https://evil.com/?x=.trace.dev"). All other characters are literal.
// Examples:
//   "https://api.trace.dev:8080"    -> prefix: that host + any subpath
//   "https://*.trace.dev:8080"      -> any subdomain of trace.dev:8080
//   "https://cdn.trace.dev/**/pub/" -> any depth under cdn.trace.dev
const patternCache = new Map<string, RegExp>();

function globToRegExp(pattern: string): RegExp {
    let out = '^';
    let i = 0;
    while (i < pattern.length) {
        const c = pattern[i];
        if (c === '*') {
            if (pattern[i + 1] === '*') {
                out += '.*';
                i += 2;
            } else {
                out += '[^/]*';
                i += 1;
            }
        } else {
            // escape regex metacharacters ("*" is handled above)
            out += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
            i += 1;
        }
    }
    return new RegExp(out);
}

function matchesPattern(pattern: string, url: string): boolean {
    if (pattern.indexOf('*') === -1) return url.startsWith(pattern);
    let re = patternCache.get(pattern);
    if (!re) {
        re = globToRegExp(pattern);
        patternCache.set(pattern, re);
    }
    return re.test(url);
}

function wantsCredentials(config: DuckDBHTTPConfig | null, url: string): boolean {
    if (!config || !config.withCredentials) return false;
    if (config.withCredentials === true) return true;
    return Array.isArray(config.withCredentials) && config.withCredentials.some(p => matchesPattern(p, url));
}

function resolveURL(url: unknown): string {
    try {
        return new URL(String(url), (globalThis as any).location?.href).href;
    } catch (_e) {
        return String(url);
    }
}

/**
 * Install the request hooks in the current worker scope. Idempotent. Without
 * a config set, every hook is a strict pass-through; a hook failure must
 * degrade to stock behavior, never break the engine (hence the try/catch
 * around everything that is not the original call).
 */
export function installHTTPOptionsHooks(): void {
    const xhr = (globalThis as any).XMLHttpRequest;
    if (xhr && xhr.prototype && !xhr.prototype.__duckdbHTTPOptions) {
        const proto = xhr.prototype;
        proto.__duckdbHTTPOptions = true;
        const origOpen = proto.open;
        proto.open = function (this: any, ...args: any[]) {
            const result = origOpen.apply(this, args);
            try {
                const url = resolveURL(args[1]);
                this.__duckdbURL = url;
                if (wantsCredentials(getHTTPOptions(), url)) this.withCredentials = true;
            } catch (_e) {
                // ignore — request proceeds with stock behavior
            }
            return result;
        };
        const origSend = proto.send;
        proto.send = function (this: any, ...args: any[]) {
            try {
                const config = getHTTPOptions();
                const url = this.__duckdbURL;
                if (config && config.headers && typeof url === 'string') {
                    for (const prefix of Object.keys(config.headers)) {
                        if (!matchesPattern(prefix, url)) continue;
                        const headers = config.headers[prefix];
                        for (const name of Object.keys(headers)) {
                            try {
                                this.setRequestHeader(name, String(headers[name]));
                            } catch (_e) {
                                // forbidden/invalid header name — skip it
                            }
                        }
                    }
                }
            } catch (_e) {
                // ignore — request proceeds with stock behavior
            }
            return origSend.apply(this, args);
        };
    }

    const NativeWorker = (globalThis as any).Worker;
    if (typeof NativeWorker === 'function' && !NativeWorker.__duckdbHTTPOptions) {
        class DuckDBHTTPOptionsWorker extends NativeWorker {
            constructor(url: any, opts: any) {
                let target = url;
                try {
                    const config = getHTTPOptions();
                    // module workers have no importScripts — leave them alone
                    if (config && !(opts && opts.type === 'module')) {
                        const boot =
                            `self.${HTTP_OPTIONS_GLOBAL}=` +
                            JSON.stringify(config) +
                            ';importScripts(' +
                            JSON.stringify(resolveURL(url)) +
                            ');';
                        target = URL.createObjectURL(new Blob([boot], { type: 'text/javascript' }));
                    }
                } catch (_e) {
                    target = url;
                }
                super(target, opts);
                try {
                    spawnedWorkers.add(this as any);
                } catch (_e) {
                    // registry is best-effort
                }
            }
        }
        (DuckDBHTTPOptionsWorker as any).__duckdbHTTPOptions = true;
        (globalThis as any).Worker = DuckDBHTTPOptionsWorker;
    }
}
