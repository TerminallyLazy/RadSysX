// Explicit opt-in cloud acceptance. Only generated synthetic imaging is used.
// The normal backend reads .env.ai; this script never loads provider keys.
process.argv.push('--viewer-launch', '--real-openai');
process.env.RADSYSX_KEEP_UI_IMPORT_SMOKE_TMP = '1';
await import('./ui-import-smoke.mjs');
