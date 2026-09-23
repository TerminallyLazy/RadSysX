import assert from 'node:assert/strict';
import test from 'node:test';
import { SubscriptionController, codexLoginUrl } from '../.cache/live-runtime/subscription.js';
import { credentialSettingsMarkup } from '../.cache/live-runtime/panel.js';

const response = value => new Response(JSON.stringify(value));
const signedOut = { available:true, signedIn:false, email:null, plan:null, loginState:'idle', credentialStorage:'keyring' };

test('subscription login uses owned HTTP, explicit browser link and verified account status', async t => {
  const old = globalThis.fetch; t.after(() => globalThis.fetch = old);
  const calls = []; let status = signedOut, ended = 0, updated = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({url,init});
    return response(url.endsWith('/login') ? { authUrl:'https://auth.openai.com/authorize?state=synthetic' } : status);
  };
  const c = new SubscriptionController(() => {}, async () => { ended++; }, async () => { updated++; });
  t.after(() => c.stop());
  await c.refresh(); await c.login();
  assert.equal(ended,1); assert.equal(c.account.signedIn,false); assert.ok(c.loginUrl.startsWith('https://auth.openai.com/'));
  status = { ...signedOut, signedIn:true, email:'synthetic@example.invalid', plan:'pro', loginState:'completed' };
  await c.refresh();
  assert.equal(c.account.signedIn,true); assert.equal(c.loginUrl,''); assert.equal(updated,1);
  status = signedOut; await c.logout();
  assert.equal(c.account.signedIn,false); assert.equal(ended,2);
  assert.ok(calls.every(({init}) => init.credentials === 'include' && init.cache === 'no-store'));
  assert.match(credentialSettingsMarkup(), /Sign in with ChatGPT/);
});

test('subscription rejects malicious login destinations and ignores stale replies after close', async t => {
  for (const url of ['http://auth.openai.com/', 'https://auth.openai.com.evil.invalid/', 'https://secret@chatgpt.com/', 'file:///secret']) assert.throws(() => codexLoginUrl(url));
  const old = globalThis.fetch; t.after(() => globalThis.fetch = old);
  let resolve; globalThis.fetch = () => new Promise(r => { resolve = r; });
  const c = new SubscriptionController(() => {}, async () => {}, async () => {});
  const pending = c.refresh(); c.stop(); resolve(response({...signedOut,signedIn:true})); await pending;
  assert.equal(c.account,undefined); assert.equal(c.busy,false);
});
