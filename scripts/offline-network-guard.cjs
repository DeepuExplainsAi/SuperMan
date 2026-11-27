/* eslint @typescript-eslint/no-require-imports: "off" -- Loaded by Node --require before the production entry point. */
// Test-only guard: reject and record any attempt to contact the removed cloud backends.
const fs = require('node:fs');
const blocked = (value) => {
  let host = '';
  try { host = typeof value === 'string' || value instanceof URL ? new URL(value).hostname : value?.hostname || value?.host || ''; } catch { return; }
  if (/(^|\.)orgo\.(?:ai|dev)$|(^|\.)supabase\.co$/i.test(host)) {
    if (process.env.OPENMAN_NETWORK_AUDIT) fs.appendFileSync(process.env.OPENMAN_NETWORK_AUDIT, host + '\n');
    throw new Error('Removed cloud backend requested: ' + host);
  }
};
for (const name of ['node:http', 'node:https']) {
  const transport = require(name);
  for (const method of ['request', 'get']) {
    const original = transport[method]; transport[method] = function (...args) { blocked(args[0]); return original.apply(this, args); };
  }
}
const originalFetch = globalThis.fetch;
globalThis.fetch = function (input, init) { blocked(typeof input === 'object' && input.url ? input.url : input); return originalFetch(input, init); };
