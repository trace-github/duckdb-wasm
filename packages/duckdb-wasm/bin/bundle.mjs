import esbuild from 'esbuild';
import fs from 'fs';
import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
import path from 'path';
import { rimraf } from 'rimraf';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

// -------------------------------
// Current bundling strategy
//
// We actually aim to be an ESM-only package but thats not possible for several reasons today.
//
// A) Karma does not support esm tests which has the following consequences:
// A.1) tests-browser.js needs to be an iife
// A.2) The worker scripts need to stay a iife since Karma can't import them otherwise (import.meta.url)
// B) Users that bundle our main modules might not want to also bundle our workers themselves, therefore:
// B.1) The workers remain self-contained iife and don't need to be bundled.
// B.2) That also allows us to host the iife workers on jsdelivr/unpkg.
// C) On node, we dynamically require "stream" (via apache-arrow) so node bundles have to stay commonjs for now.
//
// Bundles:
//   duckdb-browser.mjs                           - ESM Default Browser Bundle
//   duckdb-browser-blocking.mjs                  - ESM Blocking Browser Bundle (synchronous API, unstable)
//   duckdb-browser-mvp.worker.js                 - IIFE Web Worker for Wasm MVP
//   duckdb-browser-eh.worker.js                  - IIFE Web Worker with Wasm EH
//   duckdb-browser-coi.worker.js                 - IIFE Web Worker with Wasm EH + COI
//   duckdb-browser-coi.pthread.worker.js         - IIFE PThread Worker with Wasm EH + COI
//   duckdb-node.cjs                              - CommonJS Default Node Bundle
//   duckdb-node-blocking.cjs                     - CommonJS Blocking Node Bundle (synchronous API, unstable)
//   duckdb-node-mvp.worker.cjs                   - CommonJS Worker for Wasm MVP
//   duckdb-node-eh.worker.cjs                    - CommonJS Worker with Wasm EH
//   tests-browser.js                             - IIFE Jasmine Karma tests
//   tests-node.cjs                               - CommonJS Jasmine Node tests
//
// The lack of alternatives for Karma won't allow us to bundle workers and tests as ESM.
// We should upgrade all CommonJS bundles to ESM as soon as the dynamic requires are resolved.

const TARGET_BROWSER = ['chrome67', 'edge79', 'firefox68', 'safari15'];
const TARGET_BROWSER_TEST = ['es2020'];
const TARGET_NODE = ['node14.6'];
const EXTERNALS_NODE = ['apache-arrow'];
const EXTERNALS_BROWSER = ['apache-arrow', 'module'];
const EXTERNALS_WEBWORKER = ['module'];
const EXTERNALS_TEST_BROWSER = ['module'];

// Read CLI flags
let is_debug = false;
let args = process.argv.slice(2);
if (args.length == 0) {
    console.warn('Usage: node bundle.mjs {debug/release}');
} else {
    if (args[0] == 'debug') is_debug = true;
}
console.log(`DEBUG=${is_debug}`);
function printErr(err) {
    if (err) return console.log(err);
}

// Patch broken arrow package.json
// XXX Remove this hack as soon as arrow fixes the exports
// function patch_arrow() {
//     const package_path = '../../node_modules/apache-arrow/package.json';
//     const package_raw = fs.readFileSync(package_path);
//     const package_json = JSON.parse(package_raw);
//     package_json.exports = {
//         node: {
//             import: './Arrow.node.mjs',
//             require: './Arrow.node.js',
//         },
//         import: './Arrow.dom.mjs',
//         default: './Arrow.dom.js',
//     };
//     fs.writeFileSync(package_path, JSON.stringify(package_json));
// }
// patch_arrow();

// -------------------------------
// Cleanup output directory

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(__dirname, '..', 'dist');
await mkdir(dist, {recursive: true});
await Promise.all([
    `${dist}/*.wasm`,
    `${dist}/*.d.ts`,
    `${dist}/*.js`,
    `${dist}/*.js.map`,
    `${dist}/*.mjs`,
    `${dist}/*.mjs.map`,
    `${dist}/*.cjs`,
    `${dist}/*.cjs.map`
].map(glob => rimraf(glob)));

// -------------------------------
// Copy WASM files

const src = path.resolve(__dirname, '..', 'src');
fs.copyFile(path.resolve(src, 'bindings', 'duckdb-mvp.wasm'), path.resolve(dist, 'duckdb-mvp.wasm'), printErr);
fs.copyFile(path.resolve(src, 'bindings', 'duckdb-eh.wasm'), path.resolve(dist, 'duckdb-eh.wasm'), printErr);
fs.copyFile(path.resolve(src, 'bindings', 'duckdb-coi.wasm'), path.resolve(dist, 'duckdb-coi.wasm'), printErr);

(async () => {
    // Don't attempt to bundle NodeJS modules in the browser build.
    console.log('[ ESBUILD ] Patch bindings');
    patchFile('./src/bindings/duckdb-mvp.js', 'child_process');
    patchFile('./src/bindings/duckdb-eh.js', 'child_process');
    patchFile('./src/bindings/duckdb-coi.js', 'child_process');
    patchFile('./src/bindings/duckdb-coi.pthread.js', 'vm');
    // Emscripten 4.0.3 generates require("crypto") for node compat; patch for browser builds
    patchFile('./src/bindings/duckdb-mvp.js', 'crypto');
    patchFile('./src/bindings/duckdb-eh.js', 'crypto');
    patchFile('./src/bindings/duckdb-coi.js', 'crypto');
    // Patch COI pthread memory: emscripten skips wasmMemory init when ENVIRONMENT_IS_PTHREAD,
    // but the custom pthread worker sets Module["wasmMemory"] before calling DuckDB(m).
    // Without this, the local wasmMemory var stays undefined and WebAssembly.Instance fails.
    patchCoiPthreadMemory('./src/bindings/duckdb-coi.js');
    // Expose wasmMemory on Module for COI memory growth detection (see runtime.ts).
    patchExposeWasmMemory('./src/bindings/duckdb-coi.js');

    // -------------------------------
    // Browser bundles

    // console.log('[ ESBUILD ] duckdb-browser.cjs');
    // await esbuild.build({
    //     entryPoints: ['./src/targets/duckdb.ts'],
    //     outfile: 'dist/duckdb-browser.cjs',
    //     platform: 'browser',
    //     format: 'cjs',
    //     target: TARGET_BROWSER,
    //     bundle: true,
    //     minify: !is_debug,
    //     sourcemap: is_debug ? 'inline' : true,
    //     external: EXTERNALS_BROWSER,
    //     define: { 'process.release.name': '"browser"' },
    // });

    // console.log('[ ESBUILD ] duckdb-browser.mjs');
    // await esbuild.build({
    //     entryPoints: ['./src/targets/duckdb.ts'],
    //     outfile: 'dist/duckdb-browser.mjs',
    //     platform: 'browser',
    //     format: 'esm',
    //     globalName: 'duckdb',
    //     target: TARGET_BROWSER,
    //     bundle: true,
    //     minify: !is_debug,
    //     sourcemap: is_debug ? 'inline' : true,
    //     external: EXTERNALS_BROWSER,
    //     define: { 'process.release.name': '"browser"' },
    // });

    // console.log('[ ESBUILD ] duckdb-browser-blocking.cjs');
    // await esbuild.build({
    //     entryPoints: ['./src/targets/duckdb-browser-blocking.ts'],
    //     outfile: 'dist/duckdb-browser-blocking.cjs',
    //     platform: 'browser',
    //     format: 'cjs',
    //     target: TARGET_BROWSER,
    //     bundle: true,
    //     minify: !is_debug,
    //     sourcemap: is_debug ? 'inline' : true,
    //     external: EXTERNALS_BROWSER,
    //     define: {
    //         'process.release.name': '"browser"',
    //         'process.env.NODE_ENV': '"production"',
    //     },
    // });

    // console.log('[ ESBUILD ] duckdb-browser-blocking.mjs');
    // await esbuild.build({
    //     entryPoints: ['./src/targets/duckdb-browser-blocking.ts'],
    //     outfile: 'dist/duckdb-browser-blocking.mjs',
    //     platform: 'browser',
    //     format: 'esm',
    //     target: TARGET_BROWSER,
    //     bundle: true,
    //     minify: !is_debug,
    //     sourcemap: is_debug ? 'inline' : true,
    //     external: EXTERNALS_BROWSER,
    //     define: {
    //         'process.release.name': '"browser"',
    //         'process.env.NODE_ENV': '"production"',
    //     },
    // });

    console.log('[ ESBUILD ] duckdb-browser-mvp.worker.js');
    await esbuild.build({
        entryPoints: ['./src/targets/duckdb-browser-mvp.worker.ts'],
        outfile: 'dist/duckdb-browser-mvp.worker.js',
        platform: 'browser',
        format: 'iife',
        globalName: 'duckdb',
        target: TARGET_BROWSER,
        bundle: true,
        minify: !is_debug,
        sourcemap: is_debug ? 'inline' : true,
        external: EXTERNALS_WEBWORKER,
        define: { 'process.release.name': '"browser"' },
    });

    console.log('[ ESBUILD ] duckdb-browser-eh.worker.js');
    await esbuild.build({
        entryPoints: ['./src/targets/duckdb-browser-eh.worker.ts'],
        outfile: 'dist/duckdb-browser-eh.worker.js',
        platform: 'browser',
        format: 'iife',
        globalName: 'duckdb',
        target: TARGET_BROWSER,
        bundle: true,
        minify: !is_debug,
        sourcemap: is_debug ? 'inline' : true,
        external: EXTERNALS_WEBWORKER,
        define: { 'process.release.name': '"browser"' },
    });

    console.log('[ ESBUILD ] duckdb-browser-coi.worker.js');
    await esbuild.build({
        entryPoints: ['./src/targets/duckdb-browser-coi.worker.ts'],
        outfile: 'dist/duckdb-browser-coi.worker.js',
        platform: 'browser',
        format: 'iife',
        globalName: 'duckdb',
        target: TARGET_BROWSER,
        bundle: true,
        minify: !is_debug,
        sourcemap: is_debug ? 'inline' : true,
        external: EXTERNALS_WEBWORKER,
        define: { 'process.release.name': '"browser"' },
    });

    console.log('[ ESBUILD ] duckdb-browser-coi.pthread.worker.js');
    await esbuild.build({
        entryPoints: ['./src/targets/duckdb-browser-coi.pthread.worker.ts'],
        outfile: 'dist/duckdb-browser-coi.pthread.worker.js',
        platform: 'browser',
        format: 'iife',
        target: TARGET_BROWSER,
        bundle: true,
        minify: !is_debug,
        sourcemap: is_debug ? 'inline' : true,
        external: EXTERNALS_WEBWORKER,
        define: { 'process.release.name': '"browser"' },
    });

    // -------------------------------
    // Node bundles

    console.log('[ ESBUILD ] duckdb-node.mjs');
    await esbuild.build({
        entryPoints: ['./src/worker_node.ts'],
        outfile: 'dist/duckdb-node.mjs',
        platform: 'node',
        format: 'esm',
        target: TARGET_NODE,
        bundle: true,
        minify: !is_debug,
        sourcemap: is_debug ? 'inline' : true,
        external: ['worker_threads', 'fs'],
    });

    console.log('[ ESBUILD ] duckdb-node-mvp.worker.cjs');
    await esbuild.build({
        entryPoints: ['./src/targets/duckdb-node-mvp.worker.ts'],
        outfile: 'dist/duckdb-node-mvp.worker.cjs',
        platform: 'node',
        format: 'cjs',
        target: TARGET_NODE,
        bundle: true,
        minify: !is_debug,
        sourcemap: is_debug ? 'inline' : true,
        external: EXTERNALS_NODE,
    });

    console.log('[ ESBUILD ] duckdb-node-eh.worker.cjs');
    await esbuild.build({
        entryPoints: ['./src/targets/duckdb-node-eh.worker.ts'],
        outfile: 'dist/duckdb-node-eh.worker.cjs',
        platform: 'node',
        format: 'cjs',
        target: TARGET_NODE,
        bundle: true,
        minify: !is_debug,
        sourcemap: is_debug ? 'inline' : true,
        external: EXTERNALS_NODE,
    });

    // -------------------------------
    // Test bundles

    // console.log('[ ESBUILD ] tests-browser.js');
    // await esbuild.build({
    //     entryPoints: ['./test/index_browser.ts'],
    //     outfile: 'dist/tests-browser.js',
    //     platform: 'browser',
    //     format: 'iife',
    //     globalName: 'duckdb',
    //     target: TARGET_BROWSER_TEST,
    //     bundle: true,
    //     sourcemap: is_debug ? 'inline' : true,
    //     external: EXTERNALS_TEST_BROWSER,
    // });

    // console.log('[ ESBUILD ] tests-node.cjs');
    // await esbuild.build({
    //     entryPoints: ['./test/index_node.ts'],
    //     outfile: 'dist/tests-node.cjs',
    //     platform: 'node',
    //     format: 'cjs',
    //     target: TARGET_NODE,
    //     bundle: true,
    //     minify: false,
    //     sourcemap: is_debug ? 'inline' : true,
    //     // web-worker polyfill needs to be excluded from bundling due to their dynamic require messing with bundled modules
    //     external: [...EXTERNALS_NODE, 'web-worker'],
    // });

    // -------------------------------
    // Write declaration files

    // Browser declarations
    await writeFile(
        path.join(dist, 'duckdb-browser.d.ts'),
        "export * from './types/targets/duckdb';",
        printErr,
    );

    // Node declarations
    await writeFile(
        path.join(dist, 'duckdb-node.d.ts'),
        "export { createWorker } from './types/worker_node';",
        printErr,
    );

    // -------------------------------
    // Patch sourcemaps

    let files = await readdir(dist);
    for (const file of files) {
        if (!file.endsWith('js.map')) {
            continue;
        }
        const filePath = path.join(dist, file);
        const content = await (await readFile(filePath)).toString();
        const replaced = content.replace(/\.\.\/node_modules\//g, '');
        await writeFile(filePath, replaced, 'utf-8');
        console.log(`Patched ${file}`);
    }
})();

function patchFile(fileName, moduleName) {
    // Patch file to make sure ESBuild doesn't statically analyse and attempt to load "moduleName"
    // We replace both single and double-quoted module names. The character capture list complexity
    // is due to the single quote:
    // - the sed expression is executed within single quotes
    // - we have to terminate the quotes
    // - we have to escape the middle quote
    const sedCommand = `s/require(["'\\'']${moduleName}["'\\''])/["${moduleName}"].map(require)[0]/g`;
    execSync(`sed -i.bak '${sedCommand}' ${fileName} && rm ${fileName}.bak`);
}

function patchExposeWasmMemory(fileName) {
    const content = fs.readFileSync(fileName, 'utf8');
    const needle = '                updateMemoryViews()\n            }\n\n            function preRun()';
    if (!content.includes(needle)) {
        console.warn('WARN: Could not find COI wasmMemory exposure pattern to patch');
        return;
    }
    const patched = content.replace(
        needle,
        '                updateMemoryViews()\n            }\n            Module["wasmMemory"] = wasmMemory\n\n            function preRun()'
    );
    fs.writeFileSync(fileName, patched);
}

function patchPthreadLoadMessage(fileName) {
    const content = fs.readFileSync(fileName, 'utf8');
    const needle = '                    worker.postMessage({\n                        cmd: "load",\n                        handlers,\n                        wasmMemory,\n                        wasmModule\n                    })';
    if (!content.includes(needle)) {
        console.warn('WARN: Could not find pthread load message pattern to patch');
        return;
    }
    const patched = content.replace(
        needle,
        '                    worker.postMessage({\n                        cmd: "load",\n                        handlers,\n                        urlOrBlob: Module["_coiMainModuleUrl"] || _scriptName,\n                        wasmMemory,\n                        wasmModule\n                    })'
    );
    fs.writeFileSync(fileName, patched);
}

function patchDisableAutoInit(fileName) {
    const content = fs.readFileSync(fileName, 'utf8');
    const needle = '// When running as a pthread, construct a new instance on startup\nisPthread && DuckDB();';
    if (!content.includes(needle)) {
        console.warn('WARN: Could not find pthread auto-init pattern to patch');
        return;
    }
    const patched = content.replace(
        needle,
        '// Auto-init disabled: the pthread stub calls DuckDB(Module) explicitly.\n// isPthread && DuckDB();'
    );
    fs.writeFileSync(fileName, patched);
}

function patchCoiPthreadMemory(fileName) {
    // Emscripten wraps wasmMemory init in if(!ENVIRONMENT_IS_PTHREAD), but the bundled
    // pthread worker sets Module["wasmMemory"] before calling DuckDB(m). We insert a
    // line to pick up Module["wasmMemory"] even in the pthread case.
    const content = fs.readFileSync(fileName, 'utf8');
    const needle = 'if (!ENVIRONMENT_IS_PTHREAD) {\n                if (Module["wasmMemory"]) {\n                    wasmMemory = Module["wasmMemory"]';
    if (!content.includes(needle)) {
        // Already patched or format changed
        console.warn('WARN: Could not find COI pthread memory pattern to patch');
        return;
    }
    const patched = content.replace(
        needle,
        'if (ENVIRONMENT_IS_PTHREAD && Module["wasmMemory"]) {\n                wasmMemory = Module["wasmMemory"]\n            }\n            if (!ENVIRONMENT_IS_PTHREAD) {\n                if (Module["wasmMemory"]) {\n                    wasmMemory = Module["wasmMemory"]'
    );
    fs.writeFileSync(fileName, patched);
}
