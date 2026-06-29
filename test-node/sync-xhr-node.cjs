// Robust SYNCHRONOUS XMLHttpRequest for Node, matching the surface duckdb-wasm's
// http_wasm.cc uses (open(method,url,false); setRequestHeader; send(null|Uint8Array);
// status; response:ArrayBuffer; getAllResponseHeaders()).
//
// Node has no XHR and its fetch is async, but the wasm calls HTTP synchronously.
// We run fetch on a persistent worker thread and block the calling thread with
// Atomics.wait, then pull the response synchronously via receiveMessageOnPort —
// the standard sync-over-async pattern (cf. synckit). No subprocess, no curl, no
// native addons; handles binary bodies via structured-clone transfer.
//
// In a browser this file is never used — the native XMLHttpRequest is present.
const { Worker, MessageChannel, receiveMessageOnPort } = require('node:worker_threads');
const { join } = require('node:path');

const REQUEST_TIMEOUT_MS = 60_000;

let state = null;
function ensureWorker() {
  if (state) return state;
  const sab = new SharedArrayBuffer(4);
  const ctrl = new Int32Array(sab);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(join(__dirname, 'sync-xhr-worker.cjs'), {
    workerData: { sab, port: port2 },
    transferList: [port2],
  });
  worker.unref(); // don't keep the process alive on our account
  state = { ctrl, port: port1 };
  return state;
}

class XMLHttpRequest {
  constructor() {
    this._headers = {};
    this.status = 0;
    this.response = null;
    this.responseType = '';
    this._respHeaders = '';
  }
  open(method, url /*, async */) { this._method = method; this._url = url; }
  setRequestHeader(k, v) { this._headers[k] = v; }
  send(body) {
    const { ctrl, port } = ensureWorker();
    Atomics.store(ctrl, 0, 0);

    let buf = null;
    if (body != null) {
      const u8 = body instanceof Uint8Array ? body : new Uint8Array(body);
      buf = u8.slice().buffer; // standalone, transferable ArrayBuffer
    }
    port.postMessage(
      { url: this._url, method: this._method, headers: this._headers, body: buf },
      buf ? [buf] : [],
    );

    const r = Atomics.wait(ctrl, 0, 0, REQUEST_TIMEOUT_MS);
    if (r === 'timed-out') { this.status = 0; this.response = new ArrayBuffer(0); return; }

    const msg = receiveMessageOnPort(port);
    if (!msg) { this.status = 0; this.response = new ArrayBuffer(0); return; }
    this.status = msg.message.status;
    this.response = msg.message.body;
    this._respHeaders = msg.message.headers;
  }
  getAllResponseHeaders() { return this._respHeaders; }
}

module.exports = XMLHttpRequest;
module.exports.XMLHttpRequest = XMLHttpRequest;
