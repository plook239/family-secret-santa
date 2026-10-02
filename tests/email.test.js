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
const migrationNames = ['20261002000100_secret_santa.sql','20261002000200_email_delivery.sql','20261002000300_explicit_atomic_reset.sql','20261002000400_delete_event_data.sql'];
async function fixture({ provider, configure = {}, migrationOnly = false, beforeEmailMigration, restrictOutboxForeignKey = false,
  skipResetMigration = false, rejectUnrestrictedResetDeletes = false } = {}) {
  const db = new PGlite(); await db.waitReady;
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  for (const [index,name] of migrationNames.entries()) {
    if (skipResetMigration && index === 2) continue;
    if (index === 1 && beforeEmailMigration) await beforeEmailMigration(db);
    await db.exec(await Deno.readTextFile(new URL('../supabase/migrations/'+name, import.meta.url)));
  }
  const envValues = { ...settings, ...configure }; const env = name => envValues[name];
  const adminHash = await sessionHash(session, password);
  await db.query('select public.santa_start_session($1)', [adminHash]);
  const calls = []; const requests = []; const accepted = new Map(); const databaseFailures = [];
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
    if (rejectUnrestrictedResetDeletes && ((name === 'santa_admin_change' && params.p_action === 'reset') || ['santa_reset_draw','santa_delete_event_data'].includes(name))) {
      // PGlite does not ship Supabase's safe-delete extension. Model its exact reported
      // policy against the actual installed function definition, then run real SQL.
      const body=(await db.query("select pg_get_functiondef('public.santa_admin_change(text,text,jsonb)'::regprocedure) as definition")).rows[0].definition;
      const deletes=body.match(/\bdelete\s+from\b[^;]*;/gi) ?? [];
      if (deletes.some(statement=>!/\bwhere\b/i.test(statement))) {
        databaseFailures.push({name,code:'21000'});
        return Response.json({code:'21000',message:'DELETE requires a WHERE clause'}, {status:400});
      }
    }
    try { return Response.json(await rpc(name, params) ?? null); }
    catch (error) { databaseFailures.push({name,code:error.code}); return Response.json({ code:error.code, message:error.message }, {status:400}); }
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
  if (restrictOutboxForeignKey) await db.exec(`alter table public.santa_email_deliveries drop constraint santa_email_deliveries_participant_id_fkey;
    alter table public.santa_email_deliveries add constraint santa_email_deliveries_participant_id_fkey
    foreign key (participant_id) references public.santa_assignments(giver_id) on delete no action;`);
  return { db, envValues, rpc, invoke, calls, requests, accepted, rows, assignments, adminHash, databaseFailures };
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

async function resetMixedDeliveryRegression(f, beforeReset) {
  await generated(f);
  const originalParticipants=JSON.stringify((await f.db.query('select * from public.santa_participants order by id')).rows);
  const originalHouseholds=JSON.stringify((await f.db.query('select * from public.santa_households order by id')).rows);
  const deliveries=await f.rows();
  // A pre-migration-style queued row has no token/payload/attempt/lease timestamps.
  await f.db.query("update public.santa_email_deliveries set status='pending',token_hash=null,encrypted_payload=null,attempt_count=0,last_attempt_at=null,sent_at=null,resend_message_id=null where participant_id=$1",[deliveries[0].participant_id]);
  await f.db.query("update public.santa_email_deliveries set status='failed',sent_at=null,resend_message_id=null,last_error='Test-only failure' where participant_id=$1",[deliveries[1].participant_id]);
  await f.db.query("update public.santa_email_deliveries set status='sending',sent_at=null,lease_id=gen_random_uuid(),lease_until=now()-interval '1 second' where participant_id=$1",[deliveries[2].participant_id]);
  const manualToken='d'.repeat(64);
  await f.db.query('insert into public.santa_reveal_tokens(participant_id,token_hash) values($1,$2)',[deliveries[0].participant_id,await hash(manualToken)]);
  const sentParticipant=(await f.db.query('select email from public.santa_participants where id=$1',[deliveries[3].participant_id])).rows[0];
  const emailedToken=f.requests.find(r=>r.payload.to[0]===sentParticipant.email).payload.text.match(/#\/reveal\/([a-f0-9]{64})/)[1];
  assert((await f.invoke('reveal-assignment',{token:emailedToken},false)).ok,'Sent email link works before reset');
  const beforeEvent=(await f.db.query('select revision from public.santa_event')).rows[0];
  if (beforeReset) await beforeReset();
  const result=await f.invoke('reset-event',{confirmation:'RESET DRAW'}); const response=await result.json();
  assert(result.ok && Object.keys(response).join()==='ok','Reset returns only success, not assignments');
  for(const table of ['santa_assignments','santa_reveal_tokens','santa_email_deliveries']) assert((await f.db.query(`select count(*)::int as count from public.${table}`)).rows[0].count===0,table+' cleared');
  assert(JSON.stringify((await f.db.query('select * from public.santa_participants order by id')).rows)===originalParticipants,'Participants unchanged');
  assert(JSON.stringify((await f.db.query('select * from public.santa_households order by id')).rows)===originalHouseholds,'Households unchanged');
  const event=(await f.db.query('select * from public.santa_event')).rows[0];
  assert(!event.drawn_at && !event.registration_locked && Number(event.revision)===Number(beforeEvent.revision)+1,'Registration reopened and revision incremented');
  assert((await f.invoke('reveal-assignment',{token:manualToken},false)).status===404,'Manual link invalidated');
  assert((await f.invoke('reveal-assignment',{token:emailedToken},false)).status===404,'Email link invalidated');
  assert((await f.invoke('set-registration',{locked:true})).ok,'Preserved participants can close registration');
  assert((await generated(f)).emailDelivery.sent===4 && (await f.rows()).length===4,'New draw creates fresh outbox and sends normally');
  assert((await f.rows()).every(r=>!deliveries.some(old=>old.delivery_id===r.delivery_id)),'New draw never reuses old delivery IDs');
}

Deno.test('reset regression: mixed queued/sent/failed/expired email state clears atomically and allows a new draw',()=>withFixture({},resetMixedDeliveryRegression));
Deno.test('reset regression: explicit child deletion also supports a non-cascading outbox FK',()=>withFixture({restrictOutboxForeignKey:true},resetMixedDeliveryRegression));

async function resetSnapshot(f) {
  const snapshot={};
  for(const table of ['santa_event','santa_assignments','santa_reveal_tokens','santa_email_deliveries','santa_participants','santa_households'])
    snapshot[table]=(await f.db.query(`select * from public.${table} order by 1`)).rows;
  return JSON.stringify(snapshot);
}

Deno.test('reset regression: production SQLSTATE 21000 with unrestricted DELETE, upgrade fixes same existing draw',()=>withFixture({skipResetMigration:true,rejectUnrestrictedResetDeletes:true},f=>resetMixedDeliveryRegression(f,async()=>{
  const before=await resetSnapshot(f);
  const result=await f.invoke('reset-event',{confirmation:'RESET DRAW'});
  assert(result.status===500 && (await result.json()).error==='The request could not be completed. Refresh and try again.','Exact production UI failure reproduced');
  assert(f.databaseFailures.at(-1).code==='21000','Exact production SQLSTATE reproduced');
  assert(await resetSnapshot(f)===before,'Rejected unrestricted delete changes no live-style rows');
  await f.db.exec(await Deno.readTextFile(new URL('../supabase/migrations/20261002000300_explicit_atomic_reset.sql',import.meta.url)));
  assert(await resetSnapshot(f)===before,'Migration changes function only, never resets existing data');
})));

Deno.test('reset regression: late SQL failure rolls back outbox, tokens, assignments and event together',()=>withFixture({},f=>resetMixedDeliveryRegression(f,async()=>{
  const before=await resetSnapshot(f);
  await f.db.exec(`create function public.test_fail_reset_update() returns trigger language plpgsql as $$
    begin if new.drawn_at is null and old.drawn_at is not null then
      raise exception using errcode='21000',message='Test-only failure after child deletes';
    end if; return new; end $$;
    create trigger test_fail_reset_update before update on public.santa_event for each row execute function public.test_fail_reset_update();`);
  const result=await f.invoke('reset-event',{confirmation:'RESET DRAW'});
  assert(result.status===500 && f.databaseFailures.at(-1).code==='21000','Late database failure returned safely');
  assert(await resetSnapshot(f)===before,'All preceding deletes and event mutation rolled back');
  await f.db.exec('drop trigger test_fail_reset_update on public.santa_event; drop function public.test_fail_reset_update();');
})));

Deno.test('full deletion: clears all family/draw rows, invalidates links and leaves a fresh usable event',()=>withFixture({rejectUnrestrictedResetDeletes:true},async f=>{
  await generated(f); const token=f.requests[0].payload.text.match(/#\/reveal\/([a-f0-9]{64})/)[1];
  const participant=(await f.rows())[0];
  await f.db.query('insert into public.santa_reveal_tokens(participant_id,token_hash) values($1,$2)',[participant.participant_id,await hash('e'.repeat(64))]);
  const revision=(await f.db.query('select revision from public.santa_event')).rows[0].revision;
  const result=await f.invoke('delete-event-data',{confirmation:'DELETE EVERYTHING'});
  assert(result.ok && JSON.stringify(await result.json())==='{"ok":true}','Deletion response contains success only');
  for(const table of ['santa_email_deliveries','santa_reveal_tokens','santa_assignments','santa_participants','santa_households'])
    assert((await f.db.query(`select * from public.${table}`)).rows.length===0,table+' cleared');
  const event=(await f.db.query('select * from public.santa_event')).rows[0];
  assert(!event.drawn_at && !event.registration_locked && Number(event.revision)>Number(revision),'Fresh event invalidates stale snapshots and reopens registration');
  assert((await f.invoke('reveal-assignment',{token},false)).status===404,'Old emailed link invalidated');
  assert((await f.invoke('reveal-assignment',{token:'e'.repeat(64)},false)).status===404,'Old manual link invalidated');
  assert((await f.invoke('admin-data')).ok,'Organizer session survives family-data cleanup');
  for(const name of ['New Maple','New Pine']) assert((await f.invoke('create-household',{name})).ok,'New households can be created');
  const houses=(await f.db.query('select id from public.santa_households order by name')).rows;
  for(const [i,name] of ['New Alice','New Bob'].entries()) assert((await f.invoke('register-participant',{name,email:`new${i}@example.test`,householdId:houses[i].id},false)).ok,'Fresh registrations work');
  await f.invoke('set-registration',{locked:true}); assert((await generated(f)).emailDelivery.sent===2,'Fresh event can draw and email');
}));

Deno.test('cleanup: both confirmations enforced in Edge and SQL, both require organizer auth',()=>withFixture({},async f=>{
  const before=await resetSnapshot(f);
  for(const [operation,phrase,rpc] of [['reset-event','RESET DRAW','santa_reset_draw'],['delete-event-data','DELETE EVERYTHING','santa_delete_event_data']]) {
    assert((await f.invoke(operation,{confirmation:phrase},false)).status===401,'No anonymous cleanup');
    for(const wrong of ['RESET EVENT','DELETE ALL EVENT DATA',phrase+' ',phrase.toLowerCase()])
      assert((await f.invoke(operation,{confirmation:wrong})).status===400,'Exact phrase required');
    let rejected=false; try {await f.rpc(rpc,{p_session_hash:f.adminHash,p_confirmation:'WRONG'});} catch(e){rejected=e.code==='PT400';}
    assert(rejected,'SQL also requires exact confirmation');
    assert(!(await f.db.query(`select has_function_privilege('anon','public.${rpc}(text,text)','execute') as allowed`)).rows[0].allowed,'Cleanup RPC private');
  }
  assert(await resetSnapshot(f)===before,'Invalid requests change nothing');
}));

Deno.test('full deletion: active email guard and late participant failure roll back every table',()=>withFixture({},async f=>{
  await generated(f);
  const participant=(await f.rows())[0];
  await f.db.query("update public.santa_email_deliveries set status='sending',lease_id=gen_random_uuid(),lease_until=now()+interval '90 seconds' where participant_id=$1",[participant.participant_id]);
  const leased=await resetSnapshot(f);
  assert((await f.invoke('delete-event-data',{confirmation:'DELETE EVERYTHING'})).status===409,'Active sending blocks full deletion');
  assert(await resetSnapshot(f)===leased,'Lease rejection clears nothing');
  await f.db.query('update public.santa_email_deliveries set lease_until=null where participant_id=$1',[participant.participant_id]);
  const before=await resetSnapshot(f);
  await f.db.exec(`create function public.test_fail_family_delete() returns trigger language plpgsql as $$
    begin raise exception using errcode='21000',message='Test-only late participant deletion failure'; end $$;
    create trigger test_fail_family_delete before delete on public.santa_participants for each statement execute function public.test_fail_family_delete();`);
  assert((await f.invoke('delete-event-data',{confirmation:'DELETE EVERYTHING'})).status===500,'Late failure returned safely');
  assert(await resetSnapshot(f)===before,'Family, draw, emails, links and settings all restored');
}));

Deno.test('full deletion: works before a draw and on an empty event; every delete has WHERE',()=>withFixture({},async f=>{
  for(const name of ['santa_admin_change(text,text,jsonb)','santa_reset_draw(text,text)','santa_delete_event_data(text,text)']) {
    const definition=(await f.db.query('select pg_get_functiondef($1::regprocedure) as definition',['public.'+name])).rows[0].definition;
    assert((definition.match(/\bdelete\s+from\b[^;]*;/gi)??[]).every(sql=>/\bwhere\b/i.test(sql)),'All installed cleanup DELETEs use explicit WHERE');
  }
  for(let i=0;i<2;i++) assert((await f.invoke('delete-event-data',{confirmation:'DELETE EVERYTHING'})).ok,'Cleanup works without assignments');
  assert((await f.db.query('select * from public.santa_participants')).rows.length===0 && (await f.db.query('select * from public.santa_households')).rows.length===0,'Empty family list');
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
  const beforeReset=await resetSnapshot(f);
  assert((await f.rpc('santa_claim_email',{p_session_hash:f.adminHash,p_exclude:(await f.rows()).filter(r=>r.participant_id!==row.participantId).map(r=>r.participant_id)}))===null,'Active lease cannot be claimed twice');
  assert((await f.invoke('reset-event',{confirmation:'RESET DRAW'})).status===409,'Reset refused during active delivery');
  assert(await resetSnapshot(f)===beforeReset,'Lease guard runs before any child deletion');
  assert((await f.invoke('issue-reveal-token',{participantId:row.participantId})).status===409,'Replacement refused during active delivery');
  await f.db.exec("update public.santa_email_deliveries set lease_until=now()-interval '1 second'");
  assert((await f.invoke('reset-event',{confirmation:'RESET DRAW'})).ok,'Reset after expired lease succeeds');
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
  await f.invoke('reset-event',{confirmation:'RESET DRAW'});
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
  assert((await f.invoke('reset-event',{confirmation:'RESET DRAW'})).ok,'Pre-email-migration draw resets normally');
  for(const table of ['santa_assignments','santa_reveal_tokens','santa_email_deliveries']) assert((await f.db.query(`select * from public.${table}`)).rows.length===0,'Backfilled '+table+' cleared');
  assert((await f.db.query('select * from public.santa_participants')).rows.length===2 && (await f.db.query('select * from public.santa_households')).rows.length===2,'Backfilled draw preserves family');
  await f.invoke('set-registration',{locked:true}); assert((await generated(f)).emailDelivery.sent===2,'Backfilled event can draw again');
}));
