#!/usr/bin/env node
// E2E test for trace-scripts/patch-xhr-http-options.mjs (browser bundles).
//
// Proves, against real servers in a real headless Chrome:
//   1. No config              -> engine HTTP requests carry NO cookies and no
//                                custom headers (stock behavior preserved).
//   2. __DUCKDB_HTTP__ set    -> read_csv('http://...') requests carry the
//                                browser cookie (withCredentials) AND the
//                                configured custom header.
//   3. quack ATTACH           -> /quack requests (the EM_ASM XHR path from
//                                lib/src/http_wasm.cc) carry the cookie, via a
//                                proxy that fixes CORS for credentials (echoes
//                                Origin instead of quack's wildcard "*" and
//                                adds Access-Control-Allow-Credentials).
//
// Note: cross-origin cookies require exactly that server behavior in
// production too — a wildcard ACAO makes the browser reject credentialed
// responses. Preflight OPTIONS requests never carry cookies (per spec) and
// are excluded from the cookie assertions.
//
// Usage: node test-node/xhr-http-options-test.mjs   (CHROME_PATH to override)
import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startHost } from './quack-host.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, '..', 'packages', 'duckdb-wasm', 'dist');
const PAGE = join(__dirname, 'xhr-http-options-page.html');
const PAGE_PORT = 9878;
const DATA_PORT = 9879;
const QPROXY_PORT = 9880;
const QUACK_PORT = 9494;
const TOKEN = 'super_secret';
const require = createRequire(import.meta.url);
const puppeteer = require('../test-rig/node_modules/puppeteer-core');

const MIME = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.map': 'application/json' };
const CSV = 'id,name\n1,widget\n2,gadget\n3,gizmo\n';

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const home = process.env.HOME;
  const cands = [
    `${home}/.cache/puppeteer/chrome/mac_arm-142.0.7444.175/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ];
  return cands.find((p) => existsSync(p));
}

// Static page server (COOP/COEP so the COI bundle gets crossOriginIsolated).
function startPageServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      try {
        const url = req.url.split('?')[0];
        const file = url === '/' ? PAGE
          : url === '/arrow-bundle.mjs' ? join(__dirname, '..', 'test-rig', 'arrow-bundle.mjs')
          : url.startsWith('/dist/') ? join(DIST, url.slice('/dist/'.length)) : null;
        if (!file || !existsSync(file)) { res.statusCode = 404; res.end('not found'); return; }
        res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream');
        res.end(await readFile(file));
      } catch (e) { res.statusCode = 500; res.end(String(e)); }
    });
    server.listen(PAGE_PORT, () => resolve(server));
  });
}

// Data server: serves /data.csv cross-origin with credential-aware CORS and
// records what each request carried.
function startDataServer(records) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url, `http://localhost:${DATA_PORT}`);
      records.push({
        server: 'data',
        method: req.method,
        path: u.pathname,
        phase: u.searchParams.get('phase'),
        cookie: req.headers.cookie ?? null,
        xtrace: req.headers['x-trace-test'] ?? null,
      });
      const origin = req.headers.origin;
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
        res.setHeader('Access-Control-Max-Age', '0');
        res.statusCode = 204;
        res.end();
        return;
      }
      if (u.pathname === '/data.csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Length', Buffer.byteLength(CSV));
        res.end(req.method === 'HEAD' ? undefined : CSV);
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    server.listen(DATA_PORT, () => resolve(server));
  });
}

// Quack proxy: forwards to the native quack host, records cookies, and fixes
// CORS for credentialed requests (quack itself replies ACAO "*", which
// browsers reject when withCredentials is on).
function startQuackProxy(records) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      records.push({
        server: 'quack-proxy',
        method: req.method,
        path: req.url,
        cookie: req.headers.cookie ?? null,
      });
      const origin = req.headers.origin;
      const fixCors = (headers) => {
        const h = { ...headers };
        delete h['access-control-allow-origin'];
        if (origin) {
          h['access-control-allow-origin'] = origin;
          h['access-control-allow-credentials'] = 'true';
          h['vary'] = 'Origin';
        }
        return h;
      };
      const upstream = httpRequest(
        { host: 'localhost', port: QUACK_PORT, method: req.method, path: req.url, headers: { ...req.headers, host: `localhost:${QUACK_PORT}` } },
        (ures) => {
          const headers = fixCors(ures.headers);
          if (req.method === 'OPTIONS') {
            headers['access-control-allow-methods'] = 'GET,HEAD,POST,OPTIONS';
            headers['access-control-allow-headers'] = req.headers['access-control-request-headers'] || '*';
          }
          res.writeHead(ures.statusCode, headers);
          ures.pipe(res);
        },
      );
      upstream.on('error', (e) => { res.statusCode = 502; res.end('proxy error: ' + e.message); });
      req.pipe(upstream);
    });
    server.listen(QPROXY_PORT, () => resolve(server));
  });
}

async function main() {
  const log = (s, m) => console.log(`[${s}] ${m}`);
  const chrome = findChrome();
  if (!chrome) { console.error('No Chrome found; set CHROME_PATH'); process.exit(1); }
  if (!existsSync(join(DIST, 'duckdb-browser.mjs'))) { console.error('dist not built'); process.exit(1); }

  const records = [];
  const pageErrors = [];
  const consoleLines = [];
  const host = await startHost({ uri: `quack:localhost:${QUACK_PORT}`, token: TOKEN, log: (m) => log('host', m) });
  const pageServer = await startPageServer();
  const dataServer = await startDataServer(records);
  const quackProxy = await startQuackProxy(records);
  log('server', `page http://localhost:${PAGE_PORT} | data :${DATA_PORT} | quack proxy :${QPROXY_PORT} -> :${QUACK_PORT}`);

  const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox'] });
  let ok = false;
  const failures = [];
  try {
    const page = await browser.newPage();
    page.on('console', (m) => { consoleLines.push(m.text()); log('page', m.text()); });
    page.on('pageerror', (e) => { pageErrors.push(e.message); log('page:PAGEERROR', e.message); });
    await page.goto(`http://localhost:${PAGE_PORT}/`, { waitUntil: 'load' });
    await page.waitForFunction('window.__xhrTestResult || window.__xhrTestError', { timeout: 120000 });
    const err = await page.evaluate('window.__xhrTestError || null');
    if (err) throw new Error('browser client error: ' + err);
    const result = await page.evaluate('window.__xhrTestResult');
    log('page', 'result: ' + JSON.stringify(result));

    const check = (name, cond) => { if (cond) { log('assert', `PASS ${name}`); } else { failures.push(name); log('assert', `FAIL ${name}`); } };

    const dataReqs = (phase) => records.filter((r) => r.server === 'data' && r.method !== 'OPTIONS' && r.phase === phase);
    const control = dataReqs('control');
    const configured = dataReqs('configured');
    const quack = records.filter((r) => r.server === 'quack-proxy' && r.method !== 'OPTIONS');

    check('control phase issued requests', control.length > 0);
    check('control requests carry NO cookie', control.every((r) => r.cookie === null));
    check('control requests carry NO custom header', control.every((r) => r.xtrace === null));
    check('control read_csv returned 3 rows', result.controlRows === 3);

    check('configured phase issued requests', configured.length > 0);
    check('configured requests ALL carry cookie', configured.every((r) => (r.cookie || '').includes('trace_test=yes')));
    check('configured requests ALL carry X-Trace-Test header', configured.every((r) => r.xtrace === 'e2e'));
    check('configured read_csv returned 3 rows', result.configuredRows === 3);

    check('quack phase issued requests through proxy', quack.length > 0);
    check('quack requests ALL carry cookie', quack.every((r) => (r.cookie || '').includes('trace_test=yes')));
    check('quack query returned 3 rows', result.quackRows === 3);

    check('no page errors', pageErrors.length === 0);
    // The OPEN -> pthread re-broadcast must be consumed by the pthread
    // worker's own handler; if the Emscripten glue's handleMessage sees it
    // instead (it clobbers self.onmessage inside DuckDB(m)), it logs
    // "worker: received unknown command" and the config never reaches
    // pool-spawned pthreads.
    check('no unknown-command worker errors', !consoleLines.some((l) => l.includes('received unknown command')));

    ok = failures.length === 0;
  } catch (e) {
    console.error('FATAL:', e);
  } finally {
    await browser.close();
    pageServer.close(); dataServer.close(); quackProxy.close();
    await host.stop();
  }
  console.log('\nrequest log:');
  for (const r of records) console.log('  ' + JSON.stringify(r));
  console.log('\n========================================');
  console.log(ok ? '  XHR HTTP OPTIONS E2E PASSED' : `  XHR HTTP OPTIONS E2E FAILED: ${failures.join('; ')}`);
  console.log('========================================');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
