#!/usr/bin/env node
// Patches browser worker dist files after the WASM build.
//
// Fixes DuckDB v1.5.2 OPFS regression: the C++ side internally normalizes
// "opfs://file.db" to "opfs:/file.db" (single slash) and then opens the file
// a second time. Since inferDataProtocol("opfs:/...") doesn't match the
// "opfs://" prefix, it defaults to BROWSER_FILEREADER. The C++ Write() then
// throws "HTML FileReaders do not support writing".
//
// The fix has 3 parts:
//   A) Store OPFS handles under both "opfs://" and "opfs:/" key forms in
//      _preparedHandles and _files maps
//   B) getFileInfo: try alternate key form when primary lookup misses
//   C) registerFileHandle: register with C++ under BOTH path forms so that
//      the second open (with normalized single-slash path) finds the file
//      with BROWSER_FSACCESS protocol. Also register empty files (remove
//      getSize() check).
//
// Idempotent: re-running is safe. Exits non-zero if anchor patterns are missing.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = join(ROOT, 'packages/duckdb-wasm/dist');

// Find all browser worker files
const workerFiles = readdirSync(DIST_DIR)
  .filter(f => f.match(/^duckdb-browser-.*\.worker\.js$/))
  .map(f => join(DIST_DIR, f));

if (workerFiles.length === 0) {
  console.error('ERROR: No browser worker files found in', DIST_DIR);
  process.exit(1);
}

console.log(`Found ${workerFiles.length} worker files to patch.`);

let totalPatches = 0;

for (const filePath of workerFiles) {
  const fileName = filePath.split('/').pop();
  let src = readFileSync(filePath, 'utf8');
  let fileChanged = false;

  // =========================================================================
  // Patch A: prepareFileHandles — store handle under both key forms
  //
  // Pattern: RUNTIME._preparedHandles[PATH]=HANDLE,{path:PATH,handle:HANDLE,fromCached:!1}
  // After:   ...also store under "opfs:/"+PATH.slice(7) when PATH starts with "opfs://"
  // =========================================================================

  const prepareRe = /(\w+\._preparedHandles)\[(\w+)\]=(\w+),\{path:\2,handle:\3,fromCached:!1\}/;
  const prepareMatch = src.match(prepareRe);
  const PATCH_A_SIG = '/*PATCH_A*/';

  if (src.includes(PATCH_A_SIG)) {
    console.log(`  ${fileName}: Patch A already applied.`);
  } else if (prepareMatch) {
    const [fullMatch, runtime, pathVar, handleVar] = prepareMatch;
    const patchedStore = `${runtime}[${pathVar}]=${handleVar},${PATCH_A_SIG}${pathVar}.startsWith("opfs://")&&(${runtime}["opfs:/"+${pathVar}.slice(7)]=${handleVar}),{path:${pathVar},handle:${handleVar},fromCached:!1}`;
    src = src.replace(fullMatch, patchedStore);
    console.log(`  ${fileName}: Patch A applied (prepareFileHandles dual-key store).`);
    fileChanged = true;
    totalPatches++;
  } else {
    console.error(`  ERROR: ${fileName}: Patch A anchor not found.`);
    process.exit(1);
  }

  // =========================================================================
  // Patch B: getFileInfo lookup — try alternate opfs path on miss
  //
  // When C++ returns fileName="opfs:/file.db" (single slash), look up the
  // handle under the "opfs://" key if direct lookup misses.
  // =========================================================================

  const lookupRe = /(!(\w+)\._files\.has\((\w+)\.fileName\))&&(\2\._preparedHandles\[\3\.fileName\])&&\(\2\._files\.set\(\3\.fileName,\2\._preparedHandles\[\3\.fileName\]\),delete \2\._preparedHandles\[\3\.fileName\]\)/;
  const lookupMatch = src.match(lookupRe);
  const PATCH_B_SIG = 'startsWith("opfs:/")&&!';

  if (src.includes(PATCH_B_SIG)) {
    console.log(`  ${fileName}: Patch B already applied.`);
  } else if (lookupMatch) {
    const [fullLookup, hasCheck, rt, fi] = lookupMatch;
    const patched = [
      hasCheck,
      '&&(',
      `${rt}._preparedHandles[${fi}.fileName]`,
      `?(${rt}._files.set(${fi}.fileName,${rt}._preparedHandles[${fi}.fileName]),delete ${rt}._preparedHandles[${fi}.fileName])`,
      `:${fi}.fileName.startsWith("opfs:/")&&!${fi}.fileName.startsWith("opfs://")`,
      `&&${rt}._preparedHandles["opfs://"+${fi}.fileName.slice(6)]`,
      `&&(${rt}._files.set(${fi}.fileName,${rt}._preparedHandles["opfs://"+${fi}.fileName.slice(6)]),delete ${rt}._preparedHandles["opfs://"+${fi}.fileName.slice(6)])`,
      ')',
    ].join('');
    src = src.replace(fullLookup, patched);
    console.log(`  ${fileName}: Patch B applied (getFileInfo alternate key lookup).`);
    fileChanged = true;
    totalPatches++;
  } else {
    console.error(`  ERROR: ${fileName}: Patch B anchor not found.`);
    process.exit(1);
  }

  // =========================================================================
  // Patch C: registerFileHandle — dual C++ registration + remove getSize()
  //
  // Two sub-patches:
  //   C1: In registerFileHandle, after registering "opfs://path" with C++,
  //       also register "opfs:/path" (single slash) so C++ finds it later.
  //       Also store in _files under both keys.
  //   C2: Remove getSize() check so empty (new) files also get registered.
  // =========================================================================

  // --- C1: Dual registration in registerFileHandle ---
  const PATCH_C1_SIG = '/*PATCH_C1*/';

  if (src.includes(PATCH_C1_SIG)) {
    console.log(`  ${fileName}: Patch C1 already applied.`);
  } else {
    // Pattern (variable names differ per worker):
    //   let[S,O,C]=CALL(this.mod,"duckdb_web_fs_register_file_url",["string","string","number","boolean"],[PATH,PATH,P3,P4]);
    //   if(S!==0)throw new Error(ERR(this.mod,O,C));
    //   if(FREE(this.mod),globalThis.DUCKDB_RUNTIME._files=(globalThis.DUCKDB_RUNTIME._files||new Map).set(PATH,HANDLE),
    // PATH and HANDLE are function params (currently `t` and `e`) — captured dynamically.
    const regRe = /(let\[(\w+),(\w+),(\w+)\]=(\w+)\(this\.mod,"duckdb_web_fs_register_file_url",\["string","string","number","boolean"\],\[(\w+),\6,(\w+),(\w+)\]\);if\(\2!==0\)throw new Error\((\w+)\(this\.mod,\3,\4\)\);if\((\w+)\(this\.mod\),)(globalThis\.DUCKDB_RUNTIME\._files=\(globalThis\.DUCKDB_RUNTIME\._files\|\|new Map\)\.set\(\6,(\w+)\))/;
    const regMatch = src.match(regRe);

    if (regMatch) {
      const [fullReg, beforeFiles, sVar, oVar, cVar, callFn, pathVar, p3, p4, errFn, freeFn, filesSet, handleVar] = regMatch;
      const patchedReg = [
        `let[${sVar},${oVar},${cVar}]=${callFn}(this.mod,"duckdb_web_fs_register_file_url",["string","string","number","boolean"],[${pathVar},${pathVar},${p3},${p4}]);`,
        `if(${sVar}!==0)throw new Error(${errFn}(this.mod,${oVar},${cVar}));`,
        `${PATCH_C1_SIG}if(${pathVar}.startsWith("opfs://")){let _alt="opfs:/"+${pathVar}.slice(7);${callFn}(this.mod,"duckdb_web_fs_register_file_url",["string","string","number","boolean"],[_alt,_alt,${p3},${p4}])}`,
        `if(${freeFn}(this.mod),`,
        `globalThis.DUCKDB_RUNTIME._files=(globalThis.DUCKDB_RUNTIME._files||new Map).set(${pathVar},${handleVar}),${pathVar}.startsWith("opfs://")&&globalThis.DUCKDB_RUNTIME._files.set("opfs:/"+${pathVar}.slice(7),${handleVar})`,
      ].join('');
      src = src.replace(fullReg, patchedReg);
      console.log(`  ${fileName}: Patch C1 applied (dual C++ registration).`);
      fileChanged = true;
      totalPatches++;
    } else if (fileName.includes('pthread')) {
      console.log(`  ${fileName}: Patch C1 not applicable (pthread worker).`);
    } else {
      console.error(`  ERROR: ${fileName}: Patch C1 anchor not found. The minified variable names may have changed.`);
      process.exit(1);
    }
  }

  // --- D: Guard pthread postMessage of OPFS handles ---
  //
  // The COI worker sends file handles to pthreads via postMessage. However,
  // FileSystemSyncAccessHandle (used for OPFS) cannot be structured-cloned,
  // causing a DataCloneError. This patch wraps the postMessage in a try-catch
  // so OPFS handle registration doesn't crash. Pthreads don't need the handle
  // directly — all file I/O is proxied through the main worker's WASM module.
  //
  // Pattern: for(let H of this.pthread.runningWorkers)H.postMessage({cmd:"registerFileHandle",fileName:PATH,fileHandle:HANDLE})
  // After:   try{...}catch(_e){}
  const PATCH_D_SIG = '/*PATCH_D*/';

  if (src.includes(PATCH_D_SIG)) {
    console.log(`  ${fileName}: Patch D already applied.`);
  } else {
    const pthreadRe = /(for\(let (\w+) of this\.pthread\.runningWorkers\)\2\.postMessage\(\{cmd:"registerFileHandle",fileName:(\w+),fileHandle:(\w+)\}\))/;
    const pthreadMatch = src.match(pthreadRe);

    if (pthreadMatch) {
      const [fullMatch] = pthreadMatch;
      const patched = `${PATCH_D_SIG}try{${fullMatch}}catch(_e){}`;
      src = src.replace(fullMatch, patched);
      console.log(`  ${fileName}: Patch D applied (guard pthread postMessage for non-cloneable handles).`);
      fileChanged = true;
      totalPatches++;
    } else {
      // Only COI main worker has this.pthread - others can skip
      if (src.includes('this.pthread')) {
        console.error(`  ERROR: ${fileName}: Patch D anchor not found but file has pthread support.`);
        process.exit(1);
      } else {
        console.log(`  ${fileName}: Patch D not applicable (no pthread support).`);
      }
    }
  }

  // --- C2: Remove getSize() check ---
  const registerRe = /let\{handle:(\w+),path:(\w+),fromCached:(\w+)\}=(\w+);!\3&&\1\.getSize\(\)&&await this\.registerFileHandleAsync\(\2,\1,3,!0\)/g;

  let registerMatches = [...src.matchAll(registerRe)];
  if (registerMatches.length > 0) {
    for (const m of registerMatches) {
      const [fullMatch, handleVar, pathVar, cachedVar, iterVar] = m;
      const patched = `let{handle:${handleVar},path:${pathVar},fromCached:${cachedVar}}=${iterVar};!${cachedVar}&&await this.registerFileHandleAsync(${pathVar},${handleVar},3,!0)`;
      src = src.replace(fullMatch, patched);
    }
    console.log(`  ${fileName}: Patch C2 applied (${registerMatches.length}x — register empty OPFS files).`);
    fileChanged = true;
    totalPatches++;
  } else {
    const alreadyPatched = /let\{handle:\w+,path:\w+,fromCached:\w+\}=\w+;!\w+&&await this\.registerFileHandleAsync\(\w+,\w+,3,!0\)/.test(src);
    if (alreadyPatched) {
      console.log(`  ${fileName}: Patch C2 already applied.`);
    } else {
      console.log(`  ${fileName}: Patch C2 not applicable (no prepareDBFileHandle).`);
    }
  }

  if (fileChanged) {
    writeFileSync(filePath, src, 'utf8');
    console.log(`  ${fileName}: Written.`);
  }
}

console.log(`\nDone. Applied ${totalPatches} patches across ${workerFiles.length} files.`);
