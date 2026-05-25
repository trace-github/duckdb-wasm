// Worker that loads and runs the WasmFS test module.
// The OPFS backend requires Atomics.wait which blocks — only works in a worker, not the main thread.

importScripts('/wasmfs_test.js');

async function run() {
  const stdoutLines = [];
  postMessage({ type: 'log', level: 'info', message: 'Worker started, initializing WasmFSTest module...' });

  try {
    const baseUrl = self.location.origin + '/';
    postMessage({ type: 'log', level: 'info', message: 'Base URL: ' + baseUrl });

    const module = await WasmFSTest({
      mainScriptUrlOrBlob: baseUrl + 'wasmfs_test.js',
      locateFile: function(path) {
        postMessage({ type: 'log', level: 'info', message: 'locateFile: ' + path });
        return baseUrl + path;
      },
      print: function(text) {
        stdoutLines.push(text);
        postMessage({ type: 'log', level: 'info', message: '[wasm] ' + text });
      },
      printErr: function(text) {
        postMessage({ type: 'log', level: 'warn', message: '[wasm:err] ' + text });
      },
    });
    postMessage({ type: 'log', level: 'info', message: 'Module initialized successfully' });

    postMessage({ type: 'log', level: 'info', message: 'Module loaded, calling main()...' });

    const exitCode = module.callMain([]);
    postMessage({ type: 'log', level: 'info', message: 'main() returned: ' + exitCode });

    // Extract JSON results
    const fullOutput = stdoutLines.join('\n');
    const jsonMatch = fullOutput.match(/__JSON_RESULT__(.*?)__JSON_END__/s);
    let jsonResult = null;
    if (jsonMatch) {
      try {
        jsonResult = JSON.parse(jsonMatch[1]);
      } catch (e) {
        // ignore parse errors
      }
    }

    postMessage({ type: 'done', exitCode, jsonResult });
  } catch (e) {
    postMessage({ type: 'error', message: e.message, stack: e.stack });
  }
}

run();
