// Fetch worker for the synchronous XHR shim (Node). Runs on its own thread, so
// it can do async fetch while the calling (wasm) thread blocks on Atomics.wait.
const { workerData } = require('node:worker_threads');
const ctrl = new Int32Array(workerData.sab);
const port = workerData.port;

port.on('message', async (req) => {
  let out;
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body != null ? Buffer.from(req.body) : undefined,
    });
    const body = await res.arrayBuffer();
    const headers = [...res.headers].map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';
    out = { status: res.status, headers, body };
  } catch (e) {
    out = { status: 0, headers: '', body: new ArrayBuffer(0) };
  }
  // Post the result, THEN signal — so receiveMessageOnPort() finds it after wake.
  port.postMessage(out, [out.body]);
  Atomics.store(ctrl, 0, 1);
  Atomics.notify(ctrl, 0);
});
