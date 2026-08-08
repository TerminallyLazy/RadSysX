// Intentional no-op module used by Turbopack resolveAlias to stub out
// Node.js built-ins (like 'fs') that WASM codecs reference but never
// actually call in the browser.
module.exports = {};
