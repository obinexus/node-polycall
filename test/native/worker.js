'use strict';

// Worker thread for test/native/native.test.js: drives libpolycall from its
// own OS thread through the native layer and reports what it saw.

const { parentPort, workerData } = require('node:worker_threads');
const native = require('../../lib/native');

const { mode, libraryPath, valid, invalid, missing, iterations = 1 } = workerData;
const lib = native.load({ path: libraryPath });
const outcome = (fn) => {
  try {
    return { status: fn(), detail: lib.lastError() };
  } catch (error) {
    return { status: error.status, detail: error.detail, lastError: lib.lastError() };
  }
};

if (mode === 'thread-local') {
  // fail once, then succeed: this thread's detail must end up empty and the
  // main thread's detail must be untouched
  const failed = outcome(() => lib.runConfig(missing));
  const ok = outcome(() => lib.runConfig(valid));
  parentPort.postMessage({ failed, ok, afterOk: lib.lastError() });
} else {
  const seen = { ok: 0, notFound: 0, config: 0, wrong: [] };
  for (let i = 0; i < iterations; i += 1) {
    const which = i % 3;
    const file = which === 0 ? valid : which === 1 ? missing : invalid;
    const r = outcome(() => lib.runConfig(file));
    if (which === 0 && r.status === 0 && r.detail === '') seen.ok += 1;
    else if (which === 1 && r.status === -7 && r.lastError.includes(missing)) seen.notFound += 1;
    else if (which === 2 && r.status === -13 && r.lastError !== '' && !r.lastError.includes(missing)) seen.config += 1;
    else seen.wrong.push({ i, file, ...r });
  }
  parentPort.postMessage(seen);
}
