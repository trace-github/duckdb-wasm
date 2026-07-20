export interface DuckDBQueryConfig {
    /**
     * The polling interval for queries
     */
    queryPollingInterval?: number;
    /**
     * Cast BigInt to Double?
     */
    castBigIntToDouble?: boolean;
    /**
     * Cast Timestamp to Date64?
     */
    castTimestampToDate?: boolean;
    /**
     * Cast Timestamp to Date64?
     */
    castDurationToTime64?: boolean;
    /**
     * Cast Decimal to Double?
     */
    castDecimalToDouble?: boolean;
}

export interface DuckDBFilesystemConfig {
    reliableHeadRequests?: boolean;
    /**
     * Allow falling back to full HTTP reads if the server does not support range requests.
     */
    allowFullHTTPReads?: boolean;
    /**
     * Force use of full HTTP reads, suppressing range requests.
     */
    forceFullHTTPReads?: boolean;
}

export interface DuckDBOPFSConfig {
    /**
     * Defines how `opfs://` files are handled during SQL execution.
     * - "auto": Automatically register `opfs://` files and drop them after execution.
     * - "manual": Files must be manually registered and dropped.
     */
    fileHandling?: "auto" | "manual";
}

export enum DuckDBAccessMode {
    UNDEFINED = 0,
    AUTOMATIC = 1,
    READ_ONLY = 2,
    READ_WRITE = 3,
}

/**
 * trace fork: HTTP options for engine requests (quack, read_parquet over
 * https, ...). Applied by src/bindings/http_options.ts in the browser worker
 * bundles. Must be JSON-serializable.
 */
export interface DuckDBHTTPConfig {
    /**
     * Send cookies (credentialed CORS) with engine HTTP requests.
     * true = all URLs; string[] = allowlist of URL patterns (see matching
     * below).
     * Cross-origin servers must respond with Access-Control-Allow-Origin set
     * to the exact page origin (not "*") and
     * Access-Control-Allow-Credentials: true.
     */
    withCredentials?: boolean | string[];
    /**
     * Extra request headers, keyed by URL pattern (see matching below).
     * Applied to every engine HTTP request whose absolute URL matches.
     * Headers are appended, not replaced.
     */
    headers?: Record<string, Record<string, string>>;
    /*
     * URL pattern matching (withCredentials entries and headers keys):
     *   - a pattern with no "*" is a literal prefix (matches that URL and any
     *     subpath), e.g. "https://api.trace.dev:8080"
     *   - a pattern with "*" is a glob: "*" matches any characters except "/"
     *     (so it stays within a host or path segment), "**" matches across
     *     "/". Anchored at the start. e.g. "https://*.trace.dev:8080" matches
     *     any subdomain; "https://cdn.trace.dev/**\/pub/" any depth.
     */
}

export interface DuckDBConfig {
    /**
     * The database path
     */
    path?: string;
    /**
     * The access mode
     */
    accessMode?: DuckDBAccessMode;
    /**
     * The maximum number of threads.
     * Note that this will only work with cross-origin isolated sites since it requires SharedArrayBuffers.
     */
    maximumThreads?: number;
    /**
     * The direct io flag
     */
    useDirectIO?: boolean;
    /**
     * The query config
     */
    query?: DuckDBQueryConfig;
    /**
     * The filesystem config
     */
    filesystem?: DuckDBFilesystemConfig;
    /**
     * Whether to allow unsigned extensions
     */
    allowUnsignedExtensions?: boolean;
    /**
     * Whether to use alternate Arrow conversion that preserves full range and precision of data.
     */
    arrowLosslessConversion?: boolean;
    /**
     * Custom user agent string
     */
    customUserAgent?: string;
    /**
     * opfs string
     */
    opfs?: DuckDBOPFSConfig;
    /**
     * trace fork: HTTP options for engine requests (cookies via
     * withCredentials, extra headers)
     */
    http?: DuckDBHTTPConfig;
}
