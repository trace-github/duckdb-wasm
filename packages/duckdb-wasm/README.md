# trace-duckdb-wasm

This is a custom build of DuckDB-WASM with modifications specific to our needs, but may serve as an example of how to build your own. Claude was heavily involved, so the Claude files are included to help in the future.

**What's different from the standard DuckDB-WASM package:**

- **WasmFS** — added to support multiple threads reading files concurrently
- **Statically linked extensions** — JSON and other extensions are linked directly into the WASM binary, fixing the issue where they fail to load in the standard package when running with multiple threads
- **Custom Rust extension** — a hashing extension for JSON values for increased performance (specific to our needs but may serve as a decent example of how to write one)

The source is available at [github.com/run-trace/duckdb-wasm](https://github.com/trace-github/duckdb-wasm).

## Instantiation
cdn(jsdelivr)  
```ts
import * as duckdb from '@run-trace/duckdb-wasm';

const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();

// Select a bundle based on browser checks
const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);

const worker_url = URL.createObjectURL(
  new Blob([`importScripts("${bundle.mainWorker!}");`], {type: 'text/javascript'})
);

// Instantiate the asynchronous version of DuckDB-wasm
const worker = new Worker(worker_url);
const logger = new duckdb.ConsoleLogger();
const db = new duckdb.AsyncDuckDB(logger, worker);
await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
URL.revokeObjectURL(worker_url);
```

webpack  
```ts
import * as duckdb from '@run-trace/duckdb-wasm';
import duckdb_wasm from '@run-trace/duckdb-wasm/dist/duckdb-mvp.wasm';
import duckdb_wasm_next from '@run-trace/duckdb-wasm/dist/duckdb-eh.wasm';
const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
    mvp: {
        mainModule: duckdb_wasm,
        mainWorker: new URL('@run-trace/duckdb-wasm/dist/duckdb-browser-mvp.worker.js', import.meta.url).toString(),
    },
    eh: {
        mainModule: duckdb_wasm_next,
        mainWorker: new URL('@run-trace/duckdb-wasm/dist/duckdb-browser-eh.worker.js', import.meta.url).toString(),
    },
};
// Select a bundle based on browser checks
const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
// Instantiate the asynchronous version of DuckDB-wasm
const worker = new Worker(bundle.mainWorker!);
const logger = new duckdb.ConsoleLogger();
const db = new duckdb.AsyncDuckDB(logger, worker);
await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
```
vite  
```ts
import * as duckdb from '@run-trace/duckdb-wasm';
import duckdb_wasm from '@run-trace/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvp_worker from '@run-trace/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import duckdb_wasm_eh from '@run-trace/duckdb-wasm/dist/duckdb-eh.wasm?url';
import eh_worker from '@run-trace/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
    mvp: {
        mainModule: duckdb_wasm,
        mainWorker: mvp_worker,
    },
    eh: {
        mainModule: duckdb_wasm_eh,
        mainWorker: eh_worker,
    },
};
// Select a bundle based on browser checks
const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
// Instantiate the asynchronous version of DuckDB-wasm
const worker = new Worker(bundle.mainWorker!);
const logger = new duckdb.ConsoleLogger();
const db = new duckdb.AsyncDuckDB(logger, worker);
await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
```
static served (manually download the files from https://cdn.jsdelivr.net/npm/@run-trace/duckdb-wasm/dist/)
```ts
import * as duckdb from '@run-trace/duckdb-wasm';

const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
    mvp: {
        mainModule: 'change/me/../duckdb-mvp.wasm',
        mainWorker: 'change/me/../duckdb-browser-mvp.worker.js',
    },
    eh: {
        mainModule: 'change/m/../duckdb-eh.wasm',
        mainWorker: 'change/m/../duckdb-browser-eh.worker.js',
    },
};
// Select a bundle based on browser checks
const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
// Instantiate the asynchronous version of DuckDB-wasm
const worker = new Worker(bundle.mainWorker!);
const logger = new duckdb.ConsoleLogger();
const db = new duckdb.AsyncDuckDB(logger, worker);
await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
```  

## Data Import

```ts
// Data can be inserted from an existing arrow.Table
await c.insertArrowTable(existingTable, { name: 'arrow_table' });
// ..., from a raw Arrow IPC stream
const c = await db.connect();
const streamResponse = await fetch(`someapi`);
const streamReader = streamResponse.body.getReader();
const streamInserts = [];
while (true) {
    const { value, done } = await streamReader.read();
    if (done) break;
    streamInserts.push(c.insertArrowFromIPCStream(value, { name: 'streamed' }));
}
await Promise.all(streamInserts);

// ..., from CSV files
// (interchangeable: registerFile{Text,Buffer,URL,Handle})
await db.registerFileText(`data.csv`, '1|foo\n2|bar\n');
// ... with typed insert options
await c.insertCSVFromPath('data.csv', {
    schema: 'main',
    name: 'foo',
    detect: false,
    header: false,
    delimiter: '|',
    columns: {
        col1: new arrow.Int32(),
        col2: new arrow.Utf8(),
    },
});

// ..., from JSON documents in row-major format
await db.registerFileText(
    'rows.json',
    `[
    { "col1": 1, "col2": "foo" },
    { "col1": 2, "col2": "bar" },
]`,
);
// ... or column-major format
await db.registerFileText(
    'columns.json',
    `{
    "col1": [1, 2],
    "col2": ["foo", "bar"]
}`,
);
// ... with typed insert options
await c.insertJSONFromPath('rows.json', { name: 'rows' });
await c.insertJSONFromPath('columns.json', { name: 'columns' });

// ... from a Javascript array
const myArray = [
  {
    name: 'Dan',
    age: 32,
    numberOfPets: 3
  }
];
const encoder = new TextEncoder();
const buffer = encoder.encode(myArray);
await db.registerFileBuffer(myTableName, buffer);
await c.insertJSONFromPath(myTableName, {
  schema: 'main',
  name: 'foo',
});

// ..., from Parquet files
const pickedFile: File = letUserPickFile();
await db.registerFileHandle('local.parquet', pickedFile, DuckDBDataProtocol.BROWSER_FILEREADER, true);
await db.registerFileURL('remote.parquet', 'https://origin/remote.parquet', DuckDBDataProtocol.HTTP, false);
const res = await fetch('https://origin/remote.parquet');
await db.registerFileBuffer('buffer.parquet', new Uint8Array(await res.arrayBuffer()));

// ..., by specifying URLs in the SQL text
await c.query(`
    CREATE TABLE direct AS
        SELECT * FROM "https://origin/remote.parquet"
`);
// ..., or by executing raw insert statements
await c.query(`INSERT INTO existing_table
    VALUES (1, "foo"), (2, "bar")`);

// Close the connection to release memory
await c.close();
```

## Query Execution

```ts
// Either materialize the query result
await conn.query<{ v: arrow.Int }>(`
    SELECT * FROM generate_series(1, 100) t(v)
`);
// ..., or fetch the result chunks lazily
for await (const batch of await conn.send<{ v: arrow.Int }>(`
    SELECT * FROM generate_series(1, 100) t(v)
`)) {
    // ...
}
// Close the connection to release memory
await conn.close();
```

## Prepared Statements

```ts
// Prepare query
const stmt = await conn.prepare(`SELECT v + ? FROM generate_series(0, 10000) as t(v);`);
// ... and run the query with materialized results
await stmt.query(234);
// ... or result chunks
for await (const batch of await stmt.send(234)) {
    // ...
}
// Close the statement to release memory
await stmt.close();
// Closing the connection will release statements as well
await conn.close();
```
