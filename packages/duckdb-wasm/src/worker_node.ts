import { Worker as NodeWorker } from 'worker_threads';
import { readFileSync } from 'fs';

// Preamble injected into the worker to shim Web Worker globals using parentPort
const WORKER_PREAMBLE = `
const { parentPort } = require('worker_threads');
globalThis.postMessage = (data, transfer) => parentPort.postMessage(data, transfer);
parentPort.on('message', (data) => {
    if (globalThis.onmessage) globalThis.onmessage({ data });
});
`;

/**
 * Creates a Node.js worker_threads Worker with Web Worker API compatibility.
 * Shims globalThis.postMessage/onmessage inside the worker via parentPort,
 * and wraps the main-thread handle with addEventListener/postMessage.
 */
export function createWorker(workerPath: string): Worker {
    const worker = new NodeWorker(WORKER_PREAMBLE + readFileSync(workerPath, 'utf8'), { eval: true });
    const w = worker as any;

    w.addEventListener = (event: string, handler: (e: any) => void) => {
        if (event === 'message') {
            worker.on('message', (data: any) => handler({ data }));
        } else if (event === 'error') {
            worker.on('error', (error: any) => handler({ error, message: error?.message }));
        } else if (event === 'close') {
            worker.on('exit', () => handler({}));
        }
    };

    w.removeEventListener = () => {};

    const origPostMessage = worker.postMessage.bind(worker);
    const origTerminate = worker.terminate.bind(worker);
    w.postMessage = (data: any, transfer?: ArrayBuffer[]) => {
        origPostMessage(data, transfer);
    };

    w.terminate = () => origTerminate();

    return w as unknown as Worker;
}
