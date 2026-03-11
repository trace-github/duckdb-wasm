#!/usr/bin/env node
// Test rig server: serves duckdb-wasm dist files with Cross-Origin Isolation headers
// and captures browser test output via POST /report

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DIST_DIR = join(__dirname, '..', 'packages', 'duckdb-wasm', 'dist');
const PORT = parseInt(process.env.TEST_RIG_PORT || '9876', 10);
const TIMEOUT_MS = parseInt(process.env.TEST_RIG_TIMEOUT || '60000', 10);

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.json': 'application/json',
  '.css': 'text/css',
};

let reportReceived = false;
let timeoutTimer = null;

const server = createServer(async (req, res) => {
  // COI headers on every response
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'POST' && req.url === '/report') {
    // Collect browser test results
    let body = '';
    for await (const chunk of req) body += chunk;
    const report = JSON.parse(body);

    console.log('\n' + '='.repeat(60));
    console.log('TEST RIG REPORT');
    console.log('='.repeat(60));
    console.log(`Status: ${report.status}`);
    console.log(`COI:    ${report.crossOriginIsolated}`);
    console.log(`Bundle: ${report.bundle || 'unknown'}`);
    if (report.elapsed != null) console.log(`Time:   ${report.elapsed}ms`);
    console.log('-'.repeat(60));

    if (report.logs && report.logs.length) {
      for (const entry of report.logs) {
        const prefix = entry.level === 'error' ? 'ERROR' : entry.level === 'warn' ? 'WARN' : 'LOG';
        console.log(`[${prefix}] ${entry.message}`);
      }
    }

    if (report.error) {
      console.log('\nERROR DETAILS:');
      console.log(report.error);
      if (report.stack) {
        console.log('\nSTACK TRACE:');
        console.log(report.stack);
      }
    }

    if (report.results && report.results.length) {
      console.log('\nQUERY RESULTS:');
      for (const r of report.results) {
        console.log(`  ${r.label}: ${r.value}`);
      }
    }

    console.log('='.repeat(60) + '\n');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');

    reportReceived = true;
    if (!process.env.TEST_RIG_KEEP_ALIVE) {
      setTimeout(() => process.exit(report.status === 'PASS' ? 0 : 1), 200);
    }
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    let filePath;
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === '/' || url.pathname === '/index.html') {
      filePath = join(__dirname, 'index.html');
    } else if (url.pathname.startsWith('/dist/')) {
      filePath = join(DIST_DIR, url.pathname.slice(6));
    } else {
      // Try serving from test-rig directory
      filePath = join(__dirname, url.pathname.slice(1));
    }

    try {
      await stat(filePath);
      const content = await readFile(filePath);
      const ext = extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  res.writeHead(405);
  res.end('Method not allowed');
});

server.listen(PORT, () => {
  console.log(`Test rig server listening on http://localhost:${PORT}`);
  console.log(`Serving dist from: ${DIST_DIR}`);
  console.log(`Timeout: ${TIMEOUT_MS}ms`);

  if (!process.env.TEST_RIG_KEEP_ALIVE) {
    timeoutTimer = setTimeout(() => {
      if (!reportReceived) {
        console.error('\nTIMEOUT: No report received within', TIMEOUT_MS, 'ms');
        process.exit(2);
      }
    }, TIMEOUT_MS);
  }
});