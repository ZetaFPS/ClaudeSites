'use strict';
// Tiny JSON-file database. Fine for a personal / small-group deployment;
// writes are debounced and atomic (write temp file, then rename).
const fs = require('fs');
const path = require('path');

function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'db.json');
  let data = { users: {}, emails: {}, sessions: {}, portfolios: {} };
  try {
    data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`Could not read ${file}: ${e.message}`);
  }

  let timer = null;
  function flush() {
    timer = null;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  }
  function save() {
    if (!timer) timer = setTimeout(flush, 250);
  }
  function flushNow() {
    if (timer) { clearTimeout(timer); flush(); }
  }
  process.on('exit', flushNow);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flushNow(); process.exit(0); });

  return { data, save, flushNow };
}

module.exports = { createStore };
