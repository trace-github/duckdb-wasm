#!/usr/bin/env node
// Puppeteer-based test rig runner: starts server, launches headed Chrome,
// navigates to test pages, captures console output, waits for /report POST.
//
// Usage: node test-rig/puppeteer-run.mjs [options]
//   --keep-alive      Keep server+browser running after report
//   --port PORT       Server port (default 9876)
//   --timeout MS      Timeout in ms (default 60000)
//   --coi             Run COI test
//   --evalexpr        Run evalexpr test
//   --db-stress       Run DB stress test
//   --file-stress     Run file stress test
//   --opfs-persist    Run OPFS persist test
//   --wasmfs          Run WasmFS test
//   --bench-threads   Run thread benchmark (bench-threads.html)
//   --hash-ext        Run hash_ext extension test
//   --debug-port PORT Chrome remote debugging port (default 9222)

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// ---------------------------------------------------------------------------
// Parse CLI arguments
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let port = 9876;
let timeout = 60000;
let keepAlive = false;
let page = '';
let debugPort = 9222;

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--keep-alive': keepAlive = true; break;
    case '--port':       port = parseInt(args[++i], 10); break;
    case '--timeout':    timeout = parseInt(args[++i], 10); break;
    case '--debug-port': debugPort = parseInt(args[++i], 10); break;
    case '--coi':        page = '/coi-test.html'; break;
    case '--evalexpr':   page = '/evalexpr-test.html'; break;
    case '--db-stress':  page = '/db-stress-test.html'; break;
    case '--file-stress': page = '/file-stress-test.html'; break;
    case '--opfs-persist': page = '/opfs-persist-test.html'; break;
    case '--wasmfs':     page = '/wasmfs-test.html'; break;
    case '--buffer-reg':    page = '/buffer-reg-test.html'; break;
    case '--lua':           page = '/lua-test.html'; break;
    case '--bench-threads': page = '/bench-threads.html'; break;
    case '--hash-ext':      page = '/hash-ext-test.html'; break;
    case '--metric-table':  page = '/metric-table-test.html'; break;
    default:
      console.error(`Unknown option: ${args[i]}`);
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Start the test rig server as a child process
// ---------------------------------------------------------------------------
function startServer() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      TEST_RIG_PORT: String(port),
      TEST_RIG_TIMEOUT: String(timeout),
    };
    if (keepAlive) env.TEST_RIG_KEEP_ALIVE = '1';

    const child = spawn('node', [join(__dirname, 'server.mjs')], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Forward server stdout/stderr to our stdout/stderr
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => process.stderr.write(d));

    child.on('error', reject);

    // Wait for server to be ready by polling
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      try {
        const resp = await fetch(`http://localhost:${port}/ping.html`);
        if (resp.ok) {
          clearInterval(poll);
          resolve(child);
        }
      } catch {
        if (attempts > 40) { // 10 seconds
          clearInterval(poll);
          reject(new Error('Server failed to start within 10 seconds'));
        }
      }
    }, 250);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const fs = await import('node:fs');

  // Find Chrome
  const chromePath = (() => {
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
      return process.env.CHROME_PATH;
    }
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  })();

  if (!chromePath) {
    console.error('Could not find Chrome. Set CHROME_PATH env var to your Chrome executable.');
    process.exit(1);
  }
  console.log(`Using Chrome: ${chromePath}`);

  // Start server
  console.log(`Starting test rig server on port ${port}...`);
  const serverProc = await startServer();
  console.log('Server is ready.');

  let exitCode = 0;

  // Track server exit
  let serverExited = false;
  let serverExitCode = null;
  const serverDone = new Promise((resolve) => {
    serverProc.on('close', (code) => {
      serverExited = true;
      serverExitCode = code;
      resolve(code);
    });
  });

  try {
    // Try to attach to an existing Chrome instance on the debug port
    let browser;
    try {
      browser = await puppeteer.connect({
        browserURL: `http://localhost:${debugPort}`,
      });
      console.log(`Attached to existing Chrome on debug port ${debugPort}.`);
    } catch {
      // No existing instance — launch Chrome as a detached process so it survives Node exit
      console.log(`No existing Chrome on port ${debugPort}, launching new instance.`);
      // Use a dedicated user-data-dir so this Chrome instance doesn't merge
      // into an existing one (which would ignore --remote-debugging-port)
      const userDataDir = join(tmpdir(), 'puppeteer-test-rig-chrome');
      const chromeProc = spawn(chromePath, [
        '--no-first-run',
        '--no-default-browser-check',
        '--enable-features=SharedArrayBuffer',
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${userDataDir}`,
        '--window-position=100,100',
        '--window-size=1200,900',
        'about:blank',
      ], {
        detached: true,
        stdio: 'ignore',
      });
      chromeProc.unref();

      // Wait for Chrome's debug port to become available
      for (let i = 0; i < 40; i++) {
        try {
          const resp = await fetch(`http://localhost:${debugPort}/json/version`);
          if (resp.ok) break;
        } catch { /* not ready yet */ }
        await new Promise(r => setTimeout(r, 250));
      }

      browser = await puppeteer.connect({
        browserURL: `http://localhost:${debugPort}`,
      });
    }

    const testUrl = `http://localhost:${port}${page}`;
    console.log(`Navigating to ${testUrl}`);

    // Always open a new tab for the test
    const browserPage = await browser.newPage();

    // Capture console output from the page and print to stdout
    browserPage.on('console', (msg) => {
      const type = msg.type();
      const prefix = type === 'error' ? 'BROWSER:ERROR'
        : type === 'warning' ? 'BROWSER:WARN'
        : 'BROWSER:LOG';
      // Collect text from all args
      const text = msg.text();
      console.log(`[${prefix}] ${text}`);
    });

    // Capture page errors
    browserPage.on('pageerror', (err) => {
      console.error(`[BROWSER:PAGEERROR] ${err.message}`);
    });

    // Navigate to the test page
    await browserPage.goto(testUrl, { waitUntil: 'domcontentloaded' });

    // Wait for either:
    // 1. Server exits (report received and server shut down)
    // 2. Timeout
    // 3. Browser closed by user
    const browserDisconnected = new Promise((resolve) => {
      browser.on('disconnected', () => resolve('disconnected'));
    });

    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => resolve('timeout'), timeout + 5000); // extra buffer beyond server timeout
    });

    const result = await Promise.race([
      serverDone.then(() => 'server-exit'),
      browserDisconnected.then(() => 'browser-closed'),
      timeoutPromise,
    ]);

    if (result === 'server-exit') {
      exitCode = serverExitCode ?? 0;
      if (keepAlive) {
        // Server in keep-alive mode won't exit on report, so this means something else happened
        console.log('Server exited.');
      } else {
        console.log(`Server exited with code ${exitCode}.`);
      }
    } else if (result === 'browser-closed') {
      console.log('Browser was closed by user.');
      exitCode = serverExitCode ?? 0;
    } else if (result === 'timeout') {
      console.error(`Timeout after ${timeout + 5000}ms waiting for test to complete.`);
      exitCode = 2;
    }

    // If keep-alive, wait for either the server to eventually exit or the browser to close
    if (keepAlive && !serverExited) {
      console.log('Keep-alive mode: browser and server remain running. Close the browser or Ctrl+C to exit.');
      await Promise.race([
        serverDone,
        browserDisconnected,
      ]);
    }

    // Close the test tab but leave the browser running for reuse
    if (browser.connected) {
      if (!browserPage.isClosed()) {
        await browserPage.close();
      }
      browser.disconnect();
    }

  } catch (err) {
    console.error(`Error: ${err.message}`);
    exitCode = 1;
  } finally {
    // Shut down the server if it's still running
    if (!serverExited) {
      serverProc.kill('SIGTERM');
    }
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
