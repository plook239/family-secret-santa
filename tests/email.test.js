// Real PostgreSQL + real Edge handlers, mocked Resend. Deno has no network permission.
import { PGlite } from '../.backend-test/node_modules/@electric-sql/pglite/dist/index.js';
import { createHandler } from '../supabase/functions/_shared/handler.js';
import { hash, sessionHash } from '../supabase/functions/_shared/security.js';
import { decryptInvitation, emailSettings, escapeHtml } from '../supabase/functions/_shared/email.js';
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const password = 'test-only-family-email-password-123';
const session = 'a'.repeat(64); const origin = 'https://family.example';
const settings = { SUPABASE_URL:'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY:'test-server-key',
  ADMIN_PASSWORD:password, ALLOWED_ORIGINS:origin, RESEND_API_KEY:'re_mock_only',
  EMAIL_FROM:'Family Secret Santa <santa@example.test>', PUBLIC_SITE_URL:'https://family.example/family-secret-santa/' };
const migrationNames = ['20261002000100_secret_santa.sql','20261002000200_email_delivery.sql'];
async function fixture({ provider, configure = {}, migrationOnly = false, beforeEmailMigration } = {}) {
  const db = new PGlite(); await db.waitReady;
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  for (const [index,name] of migrationNames.entries()) {
    if (index === 1 && beforeEmailMigration) await beforeEmailMigration(db);
    await db.exec(await Deno.readTextFile(new URL('../supabase/migrations/'+name, import.meta.url)));
  }
  const envValues = { ...settings, ...configure }; const env = name => envValues[name];
  const adminHash = await sessionHash(session, password);
  await db.query('select public.santa_start_session($1)', [adminHash]);
  const calls = []; const requests = []; const accepted = new Map();
  const rpc = async (name, params = {}) => {
    const keys = Object.keys(params); assert(/^santa_[a-z_]+$/.test(name), 'RPC name');
    assert(keys.every(k => /^p_[a-z_]+$/.test(k)), 'RPC parameters');
    const values = keys.map(k => params[k] !== null && typeof params[k] === 'object' ?
      (k === 'p_exclude' ? params[k] : JSON.stringify(params[k])) : params[k]);
    return (await db.query(`select public.${name}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')}) as result`, values)).rows[0].result;
  };
  const fetchApi = async (url, init) => {
    if (url === 'https://api.resend.com/emails') {
      const payload = JSON.parse(init.body); const key = init.headers['Idempotency-Key'];
      const request = { payload, key, init }; requests.push(request);
      assert((await db.query('select drawn_at from public.santa_event')).rows[0].drawn_at,'Draw committed before provider call');
      assert(!init.headers.apikey, 'No database credential sent to Resend');
      assert(init.headers.Authorization === 'Bearer '+envValues.RESEND_API_KEY, 'Resend secret used server-side');
      assert(payload.to.length === 1, 'Individual messages only');
      if (accepted.has(key)) {
        assert(JSON.stringify(payload) === accepted.get(key).body, 'Retries must freeze identical payload');
        return Response.json({ id:accepted.get(key).id });
      }
      const result = provider ? await provider(request, requests.length) : null;
      if (result instanceof Response && !result.ok) return result;
      const id = 'message-'+(accepted.size+1); accepted.set(key, { id, body:JSON.stringify(payload) });
      if (result === 'lose-response') throw new Error('Response lost after provider accepted');
      return Response.json({ id });
    }
    assert(url.startsWith('https://test.supabase.co/rest/v1/rpc/'), 'Tests cannot call unknown network targets');
    assert(init.headers.apikey === settings.SUPABASE_SERVICE_ROLE_KEY, 'Service role only used for database');
    const name = url.split('/').pop(); const params = JSON.parse(init.body); calls.push({name,params});
    try { return Response.json(await rpc(name, params) ?? null); }
    catch (error) { return Response.json({ code:error.code, message:error.message }, {status:400}); }
  };
  const invoke = async (operation, body = {}, auth = true) => createHandler(operation, env, fetchApi, { pause:async()=>{} })(new Request('https://test.supabase.co/functions/v1/'+operation,
    { method:'POST', headers:{ Origin:origin, 'Content-Type':'application/json', ...(auth ? {'X-Admin-Session':session} : {}) }, body:JSON.stringify(body) }));
  if (!migrationOnly) {
    for (const name of ['Maples','Pines']) await rpc('santa_admin_change', {p_session_hash:adminHash,p_action:'create-household',p_data:{name}});
    const houses = (await db.query('select id from public.santa_households order by name')).rows;
    for (const [i,name] of ['Alina <img src=x onerror=alert(1)>','Bastian-Pine','Camilla-Maple','Dominic-Pine'].entries())
      await rpc('santa_register', {p_name:name,p_email:`person${i}@example.test`,p_household_id:houses[i%2].id});
    await rpc('santa_admin_change', {p_session_hash:adminHash,p_action:'set-registration',p_data:{locked:true}});
  }
  const rows = async () => (await db.query('select * from public.santa_email_deliveries order by participant_id')).rows;
  const assignments = async () => JSON.stringify((await db.query('select * from public.santa_assignments order by giver_id')).rows);
  return { db, envValues, rpc, invoke, calls, requests, accepted, rows, assignments, adminHash };
}
async function withFixture(options, test) { const f = await fixture(options); try { await test(f); } finally { await f.db.close(); } }
const generated = async f => { const r = await f.invoke('generate-assignments'); assert(r.ok,'Generation succeeds'); return r.json(); };
const retry = async f => { const r = await f.invoke('retry-failed-emails'); assert(r.ok,'Retry succeeds'); return r.json(); };

Deno.test('email: all succeed, private scope, escaping, hashes only and no recipient names', () => withFixture({}, async f => {
  const result = await generated(f); assert(result.emailDelivery.sent === 4 && result.emailDelivery.failed === 0,'All four sent');
  assert(!JSON.stringify(result).includes('token') && !JSON.stringify(result).includes('recipient'),'No credentials/pairings in organizer response');
  const participants = (await f.db.query('select * from public.santa_participants')).rows;
  for (const {payload} of f.requests) {
    const person = participants.find(p=>p.email===payload.to[0]);
    assert(payload.html.includes(escapeHtml(person.name)) && payload.text.includes(person.name),'Personal greeting and safe escaping');
    assert(!payload.html.includes('<img src=x'),'User HTML cannot execute');
    for (const other of participants.filter(p=>p.id!==person.id)) assert(!payload.html.includes(escapeHtml(other.name)) && !payload.text.includes(other.name),'No other participant/recipient name');
    const token = payload.text.match(/#\/reveal\/([a-f0-9]{64})/)[1];
    assert(payload.text.includes('https://family.example/family-secret-santa/reveal.html#/reveal/'),'Repository path retained');
    const reveal = await f.invoke('reveal-assignment',{token},false); const scoped = await reveal.json();
    assert(reveal.ok && Object.keys(scoped).length===2 && scoped.participantName===person.name,'Only one token-scoped result');
    const delivery=(await f.rows()).find(d=>d.participant_id===person.id);
    assert(delivery.token_hash===await hash(token) && delivery.token_hash!==token && !delivery.encrypted_payload,'Only hash retained after successful send');
    assert(delivery.attempt_count===1 && delivery.last_attempt_at && delivery.resend_message_id,'Audit fields retained');
  }
  await retry(f); assert(f.requests.length===4,'Successful invitations are never resent');
  assert((await f.invoke('generate-assignments')).status===409,'Second draw blocked');
  assert((await f.invoke('retry-failed-emails',{},false)).status===401,'Retry requires organizer');
}));

Deno.test('email: one failure, only failed message retried, same token and unchanged assignments', () => withFixture({provider:(_r,n)=>n===2?Response.json({message:'private provider details'}, {status:422}):null}, async f => {
  const result=await generated(f); assert(result.emailDelivery.sent===3 && result.emailDelivery.failed===1,'Aggregate partial success');
  const before=await f.assignments(); const failed=(await f.rows()).find(r=>r.status==='failed');
  assert(failed.encrypted_payload && !failed.encrypted_payload.includes('#/reveal/') && !failed.encrypted_payload.includes('@'),'Private payload encrypted');
  const original=f.requests[1]; const next=await retry(f);
  assert(next.emailDelivery.sent===4 && next.emailDelivery.failed===0 && f.requests.length===5,'Only failed message retried');
  assert(f.requests[4].key===original.key && JSON.stringify(f.requests[4].payload)===JSON.stringify(original.payload),'Identical token, payload and idempotency key');
  assert(await f.assignments()===before,'Assignment rows untouched by email failure or retry');
  await retry(f); assert(f.requests.length===5,'Successful messages not resent on another retry');
  assert(f.calls.filter(c=>c.name==='santa_commit_draw').length===1,'Retries never invoke draw commit');
}));

Deno.test('email: missing configuration preserves draw and retries after configuration', () => withFixture({configure:{RESEND_API_KEY:undefined}}, async f => {
  const result=await generated(f); assert(result.ok && result.emailError.includes('RESEND_API_KEY'),'Clean configuration error with successful draw');
  const before=await f.assignments(); assert(result.emailDelivery.pending===4 && !f.requests.length,'No attempted mail with missing key');
  f.envValues.RESEND_API_KEY=settings.RESEND_API_KEY;
  assert((await retry(f)).emailDelivery.sent===4 && await f.assignments()===before,'Configure and retry without redrawing');
}));

Deno.test('email: rejected credentials stop cleanly, redact provider error, keep draw', () => withFixture({provider:()=>Response.json({message:'re_secret person0@example.test TOKEN'}, {status:401})}, async f => {
  const result=await generated(f); assert(result.emailDelivery.failed===1 && result.emailDelivery.pending===3,'Stop on key rejection');
  assert(result.emailError.includes('API key') && !JSON.stringify(result).includes('re_secret') && !JSON.stringify(result).includes('person0@'),'Safe organizer error');
  const before=await f.assignments(); await retry(f); assert(await f.assignments()===before,'Credential error never changes draw');
  assert((await f.rows()).filter(r=>r.status==='failed').every(r=>!r.last_error.includes('TOKEN')),'Database error is sanitized');
}));

Deno.test('email: lost success response retries with Resend idempotency, no duplicate accepted', () => withFixture({provider:(_r,n)=>n===1?'lose-response':null}, async f => {
  const result=await generated(f); assert(result.emailDelivery.failed===1,'Lost response recorded as failed');
  assert((await retry(f)).emailDelivery.sent===4,'Retry obtains original provider ID');
  assert(f.requests.length===5 && f.accepted.size===4,'Five requests but exactly four unique sent messages');
}));

Deno.test('email: expired ambiguous request is stopped instead of risking duplicate mail', () => withFixture({provider:(_r,n)=>n===1?'lose-response':null}, async f => {
  await generated(f); const failed=(await f.rows()).find(r=>r.status==='failed');
  await f.db.query("update public.santa_email_deliveries set uncertain_since=now()-interval '24 hours' where participant_id=$1",[failed.participant_id]);
  const result=await retry(f); assert(result.emailDelivery.uncertain===1 && f.requests.length===4,'No network retry beyond provider deduplication window');
  assert(result.emailDelivery.problems[0].error.includes('review'),'Organizer gets actionable review state');
}));

Deno.test('email: concurrent generation and concurrent retries cannot duplicate successful delivery', () => withFixture({configure:{RESEND_API_KEY:undefined}}, async f => {
  const results=await Promise.all([f.invoke('generate-assignments'),f.invoke('generate-assignments')]);
  assert(results.filter(r=>r.ok).length===1 && results.filter(r=>r.status===409).length===1,'Exactly one committed draw');
  f.envValues.RESEND_API_KEY=settings.RESEND_API_KEY;
  const before=await f.assignments(); await Promise.all([retry(f),retry(f)]);
  assert(f.requests.length===4 && f.accepted.size===4,'Database leases serialize messages between concurrent workers');
  assert(await f.assignments()===before,'Concurrent retries retain the draw');
}));

Deno.test('email: reset and manual link replacement cannot race active delivery', () => withFixture({configure:{RESEND_API_KEY:undefined}}, async f => {
  await generated(f); const row=await f.rpc('santa_claim_email',{p_session_hash:f.adminHash});
  assert((await f.rpc('santa_claim_email',{p_session_hash:f.adminHash,p_exclude:(await f.rows()).filter(r=>r.participant_id!==row.participantId).map(r=>r.participant_id)}))===null,'Active lease cannot be claimed twice');
  assert((await f.invoke('reset-event',{confirmation:'RESET EVENT'})).status===409,'Reset refused during active delivery');
  assert((await f.invoke('issue-reveal-token',{participantId:row.participantId})).status===409,'Replacement refused during active delivery');
  await f.db.exec("update public.santa_email_deliveries set lease_until=now()-interval '1 second'");
  assert((await f.invoke('reset-event',{confirmation:'RESET EVENT'})).ok,'Reset after expired lease succeeds');
  assert((await f.rows()).length===0 && (await f.db.query('select * from public.santa_assignments')).rows.length===0,'Reset cascades outbox');
  assert((await f.invoke('retry-failed-emails')).status===409,'Retry cannot generate a second draw');
}));

Deno.test('email: email hash revocation on manual replacement and reset', () => withFixture({}, async f => {
  await generated(f); const first=f.requests[0].payload; const token=first.text.match(/#\/reveal\/([a-f0-9]{64})/)[1];
  const person=(await f.db.query('select id from public.santa_participants where email=$1',[first.to[0]])).rows[0];
  const issued=await (await f.invoke('issue-reveal-token',{participantId:person.id})).json();
  assert((await f.invoke('reveal-assignment',{token},false)).status===404,'Replacement revokes emailed link');
  assert((await f.invoke('reveal-assignment',{token:issued.token},false)).ok,'Manual replacement works');
  await retry(f); assert(f.requests.length===4,'Replacement never triggers another email');
  await f.invoke('reset-event',{confirmation:'RESET EVENT'});
  assert((await f.invoke('reveal-assignment',{token:issued.token},false)).status===404 && !(await f.rows()).length,'Reset revokes all credentials and delivery records');
}));

Deno.test('email: RLS, private RPC grants, original database regression checks', () => withFixture({migrationOnly:true}, async f => {
  await f.db.exec(await Deno.readTextFile(new URL('./database.sql',import.meta.url)));
  assert((await f.db.query("select relrowsecurity from pg_class where oid='public.santa_email_deliveries'::regclass")).rows[0].relrowsecurity,'Outbox RLS enabled');
  assert(!(await f.db.query("select has_table_privilege('anon','public.santa_email_deliveries','select') as allowed")).rows[0].allowed,'Outbox not publicly queryable');
  assert(!(await f.db.query("select has_function_privilege('authenticated','public.santa_claim_email(text,uuid[])','execute') as allowed")).rows[0].allowed,'Outbox RPC unavailable to browser roles');
  const publicData=await f.rpc('santa_public_event'); assert(!('emailDelivery' in publicData),'Public endpoint excludes delivery state');
}));

Deno.test('email: configuration rejects malformed sender and site URL', () => {
  for(const configure of [{RESEND_API_KEY:'bad'}, {EMAIL_FROM:'x@example.test\r\nBcc:evil@example.test'},
    {PUBLIC_SITE_URL:'http://family.example/'},{PUBLIC_SITE_URL:'https://family.example/path'},
    {PUBLIC_SITE_URL:'https://family.example/?token=secret'}]) {
    let rejected=false; try {emailSettings(n=>({...settings,...configure})[n]);} catch {rejected=true;} assert(rejected,'Reject unsafe configuration');
  }
});

Deno.test('email: encryption authenticated to delivery, retries fail closed after password rotation', () => withFixture({provider:()=>Response.json({}, {status:422})}, async f => {
  await generated(f); const row=(await f.rows())[0];
  const payload=await decryptInvitation(row.encrypted_payload,password,row.delivery_id); assert(payload.to.length===1,'Outbox can recover same link');
  for(const [key,id] of [[password,'different-delivery-id'],['rotated-password',row.delivery_id]]) {
    let rejected=false; try {await decryptInvitation(row.encrypted_payload,key,id);} catch {rejected=true;} assert(rejected,'Wrong key or delivery fails closed');
  }
}));

Deno.test('email: expired worker resumes identical prepared payload without replacing token', () => withFixture({configure:{RESEND_API_KEY:undefined}}, async f => {
  await generated(f); const row=await f.rpc('santa_claim_email',{p_session_hash:f.adminHash});
  const { invitation, encryptInvitation }=await import('../supabase/functions/_shared/email.js');
  const token='b'.repeat(64); const payload=invitation(row,token,emailSettings(n=>settings[n]));
  await f.rpc('santa_prepare_email',{p_session_hash:f.adminHash,p_participant_id:row.participantId,p_lease_id:row.leaseId,
    p_token_hash:await hash(token),p_encrypted_payload:await encryptInvitation(payload,password,row.deliveryId)});
  await f.rpc('santa_begin_email_attempt',{p_session_hash:f.adminHash,p_participant_id:row.participantId,p_lease_id:row.leaseId});
  await f.db.query("update public.santa_email_deliveries set lease_until=now()-interval '1 second' where participant_id=$1",[row.participantId]);
  f.envValues.RESEND_API_KEY=settings.RESEND_API_KEY; await retry(f);
  const recovered=f.requests.find(r=>r.key==='santa/'+row.deliveryId);
  assert(JSON.stringify(recovered.payload)===JSON.stringify(payload),'Reclaimed lease reuses immutable encrypted email and reveal token');
  assert((await f.rows()).find(r=>r.participant_id===row.participantId).attempt_count===2,'Recovery attempt tracked');
}));

Deno.test('email: a later rejection cannot clear prior ambiguous acceptance', () => withFixture({provider:(_r,n)=>n===1?'lose-response':null}, async f => {
  await generated(f); const failed=(await f.rows()).find(r=>r.status==='failed');
  // Model a later known rejection before checking whether the earlier response was lost.
  await f.db.query("update public.santa_email_deliveries set uncertain_since=now()-interval '1 hour' where participant_id=$1",[failed.participant_id]);
  const row=await f.rpc('santa_claim_email',{p_session_hash:f.adminHash});
  await f.rpc('santa_begin_email_attempt',{p_session_hash:f.adminHash,p_participant_id:row.participantId,p_lease_id:row.leaseId});
  await f.rpc('santa_finish_email',{p_session_hash:f.adminHash,p_participant_id:row.participantId,p_lease_id:row.leaseId,
    p_message_id:null,p_error:'Definite later rejection',p_definite_failure:true});
  assert((await f.rows()).find(r=>r.participant_id===row.participantId).uncertain_since,'Earlier uncertainty retained');
}));

Deno.test('email: additive migration backfills existing draw without changing manual reveal links', () => withFixture({migrationOnly:true,beforeEmailMigration:async db => {
  await db.exec(`insert into public.santa_households(id,name) values
    ('11111111-1111-1111-1111-111111111111','Maples'),('22222222-2222-2222-2222-222222222222','Pines');
    insert into public.santa_participants(id,name,email,household_id) values
    ('33333333-3333-3333-3333-333333333333','Alina','person0@example.test','11111111-1111-1111-1111-111111111111'),
    ('44444444-4444-4444-4444-444444444444','Bastian','person1@example.test','22222222-2222-2222-2222-222222222222');
    insert into public.santa_assignments(giver_id,recipient_id) values
    ('33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444'),
    ('44444444-4444-4444-4444-444444444444','33333333-3333-3333-3333-333333333333');
    update public.santa_event set drawn_at=now(),registration_locked=true;
    insert into public.santa_reveal_tokens(participant_id,token_hash) values
    ('33333333-3333-3333-3333-333333333333',repeat('c',64));`);
}}, async f => {
  const before=await f.assignments(); const original=await f.rpc('santa_reveal',{p_token_hash:'c'.repeat(64)});
  assert((await f.rows()).length===2,'Existing assignments queued');
  assert((await retry(f)).emailDelivery.sent===2 && await f.assignments()===before,'Existing draw mailed without redrawing');
  assert(JSON.stringify(await f.rpc('santa_reveal',{p_token_hash:'c'.repeat(64)}))===JSON.stringify(original),'Previously shared manual link remains valid');
}));
