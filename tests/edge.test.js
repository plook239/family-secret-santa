// Native Deno HTTP/crypto tests, without network, secrets or external packages.
import { createHandler } from '../supabase/functions/_shared/handler.js';
import { hash, sessionHash } from '../supabase/functions/_shared/security.js';
function assert(condition, message) { if (!condition) throw new Error(message); }
const password = 'test-only-password-with-high-entropy';
const env = name => ({ SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-server-key', ADMIN_PASSWORD: password, ALLOWED_ORIGINS: 'https://family.example' })[name];
function request(body = {}, extraHeaders = {}, method = 'POST') {
  return new Request('https://test.supabase.co/functions/v1/test', {
    method, headers: { Origin: 'https://family.example', 'Content-Type': 'application/json', ...extraHeaders },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {})
  });
}
function mockRpc(resolve) {
  return async (url, init) => {
    assert(init.headers.apikey === 'test-server-key', 'Only server credential goes to PostgREST');
    const result = await resolve(url.split('/').pop(), JSON.parse(init.body));
    return Response.json(result ?? null);
  };
}
Deno.test('native request streaming and exact CORS/no-store', async () => {
  const handler = createHandler('public-event', env, mockRpc(() => ({ households: [], locked: false, drawn: false })));
  const result = await handler(request());
  assert(result.status === 200 && result.headers.get('Access-Control-Allow-Origin') === 'https://family.example', 'Allowed origin');
  assert(result.headers.get('Cache-Control') === 'no-store', 'Sensitive replies cannot be cached');
  assert((await handler(request({}, { Origin: 'https://other.example' }))).status === 403, 'Reject other origin');
  assert((await handler(request({}, {}, 'OPTIONS'))).status === 204, 'Preflight succeeds');
});
Deno.test('privileged calls reject browser state without an opaque session', async () => {
  let called = false;
  const handler = createHandler('remove-participant', env, mockRpc(() => { called = true; }));
  assert((await handler(request({ id: 'fake', admin: true, password }))).status === 401, 'Browser flag/password cannot authorize');
  assert(!called, 'Unauthenticated caller cannot reach privileged RPC');
});
Deno.test('login uses native WebCrypto and stores only a keyed session hash', async () => {
  let stored;
  const handler = createHandler('admin-login', env, mockRpc((name, body) => {
    if (name === 'santa_rate_limit') return true;
    if (name === 'santa_start_session') stored = body.p_session_hash;
  }));
  assert((await handler(request({ password: 'incorrect' }))).status === 401, 'Wrong password');
  const result = await handler(request({ password })); const login = await result.json();
  assert(result.ok && /^[a-f0-9]{64}$/.test(login.sessionToken), 'Strong session');
  assert(stored !== login.sessionToken && stored === await sessionHash(login.sessionToken, password), 'Keyed hash storage');
  assert(stored !== await sessionHash(login.sessionToken, 'rotated-secret-password'), 'Secret rotation revokes old credential');
});
Deno.test('impossible draw never calls commit', async () => {
  let committed = false;
  const handler = createHandler('generate-assignments', env, mockRpc(name => {
    if (name === 'santa_admin_data') return { drawn: false, locked: true, revision: 1, participants: [{ id:'a',householdId:'house' },{ id:'b',householdId:'house' }] };
    if (name === 'santa_commit_draw') committed = true;
  }));
  const result = await handler(request({}, { 'X-Admin-Session': 'a'.repeat(64) }));
  assert(result.status === 409 && (await result.json()).error.includes('impossible'), 'Clean impossible-draw error');
  assert(!committed, 'No write for an impossible draw');
});
Deno.test('reveal sends only a hash to database and returns scoped names', async () => {
  const token = 'b'.repeat(64); let storedHash;
  const handler = createHandler('reveal-assignment', env, mockRpc((name, body) => {
    if (name === 'santa_rate_limit') return true;
    storedHash = body.p_token_hash; return { participantName:'Alice',recipientName:'Bob' };
  }));
  const result = await handler(request({ token })); const revealed = await result.json();
  assert(storedHash !== token && storedHash === await hash(token), 'No raw token lookup/storage');
  assert(result.ok && Object.keys(revealed).length === 2 && revealed.recipientName === 'Bob', 'Exactly the authorized result');
});
Deno.test('native streamed body cap and database throttle', async () => {
  const handler = createHandler('admin-login', env, mockRpc(() => false));
  assert((await handler(request({ password }))).status === 429, 'Login throttle enforced');
  assert((await handler(request({ password: 'x'.repeat(9000) }))).status === 413, 'Body cap enforced before password processing');
});
