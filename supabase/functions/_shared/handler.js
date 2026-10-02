import { solveAssignments } from './assignment.js';
import { ApiError, hash, passwordMatches, randomToken, readBody, sessionHash, strongToken, text, uuid } from './security.js';

const publicOperations = new Set(['public-event', 'register-participant', 'admin-login', 'reveal-assignment']);
export function createHandler(operation, env, fetchApi = fetch) {
  async function rpc(name, parameters = {}) {
    const url = env('SUPABASE_URL'); const key = env('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) throw new ApiError('Server database configuration is missing.', 503);
    let response;
    try {
      response = await fetchApi(`${url}/rest/v1/rpc/${name}`, {
        method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(parameters), signal: AbortSignal.timeout(15000)
      });
    } catch { throw new ApiError('The database is temporarily unavailable. Please try again.', 503); }
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      if (data?.code?.match(/^PT(400|401|404|409|429)$/)) throw new ApiError(data.message, Number(data.code.slice(2)));
      // Never return raw Postgres errors, SQL, constraint details, or private data.
      throw new ApiError('The request could not be completed. Refresh and try again.', 500);
    }
    return data;
  }
  async function limit(bucket, count, seconds) {
    if (!await rpc('santa_rate_limit', { p_bucket: bucket, p_limit: count, p_window_seconds: seconds })) throw new ApiError('Too many requests. Please wait and try again.', 429);
  }
  return async request => {
    const origin = request.headers.get('origin');
    const allowed = (env('ALLOWED_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin', 'X-Content-Type-Options': 'nosniff' };
    if (origin && allowed.includes(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Headers'] = 'content-type, apikey, x-admin-session';
      headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
      headers['Access-Control-Max-Age'] = '600';
    }
    function response(data, status = 200) { return new Response(JSON.stringify(data), { status, headers }); }
    try {
      if (!allowed.length) throw new ApiError('Server origin configuration is missing.', 503);
      if (origin && !allowed.includes(origin)) throw new ApiError('This origin is not allowed.', 403);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      if (request.method !== 'POST') throw new ApiError('Use POST for this endpoint.', 405);
      const body = await readBody(request);
      let adminHash;
      const password = env('ADMIN_PASSWORD');
      if (!publicOperations.has(operation) || operation === 'admin-login') {
        if (!password || password.length < 16 || password.length > 1024 || password.startsWith('REPLACE_')) throw new ApiError('The organizer password is not configured securely.', 503);
      }
      if (!publicOperations.has(operation)) {
        const token = request.headers.get('x-admin-session');
        if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new ApiError('Admin sign-in required.', 401);
        adminHash = await sessionHash(token, password);
        await rpc('santa_assert_admin', { p_session_hash: adminHash });
      }
      switch (operation) {
        case 'public-event': return response(await rpc('santa_public_event'));
        case 'register-participant': {
          await limit('registration-global', 60, 3600);
          const name = text(body.name, 80, 'Name');
          const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
          if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /[\u0000-\u001f\u007f]/.test(email)) throw new ApiError('Enter a valid email address.');
          return response(await rpc('santa_register', { p_name: name, p_email: email, p_household_id: uuid(body.householdId) }));
        }
        case 'admin-login': {
          // Global, database-backed throttle avoids trusting browser-supplied IP headers.
          await limit('admin-login-global', 20, 900);
          if (typeof body.password !== 'string' || body.password.length > 1024 || !await passwordMatches(body.password, password)) throw new ApiError('Incorrect organizer password.', 401);
          const token = randomToken();
          await rpc('santa_start_session', { p_session_hash: await sessionHash(token, password) });
          return response({ sessionToken: token, expiresAt: new Date(Date.now() + 4 * 3600000).toISOString() });
        }
        case 'admin-logout': await rpc('santa_end_session', { p_session_hash: adminHash }); return response({ ok: true });
        case 'admin-data': return response(await rpc('santa_admin_data', { p_session_hash: adminHash }));
        case 'generate-assignments': {
          const event = await rpc('santa_admin_data', { p_session_hash: adminHash });
          if (event.drawn) throw new ApiError('The draw is already complete. Reset is required to draw again.', 409);
          if (!event.locked) throw new ApiError('Close registration before drawing names.', 409);
          let pairs;
          // Use the original tested solver; secure random candidate order on the server.
          try { pairs = solveAssignments(event.participants, () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296); }
          catch (error) { throw new ApiError(error.message, 409); }
          await rpc('santa_commit_draw', { p_session_hash: adminHash, p_revision: event.revision, p_pairs: pairs });
          return response({ ok: true });
        }
        case 'issue-reveal-token': {
          const id = uuid(body.participantId);
          const event = await rpc('santa_admin_data', { p_session_hash: adminHash });
          if (!event.drawn || !event.participants.some(p => p.id === id)) throw new ApiError('Participant not found in a completed draw.', 404);
          const token = randomToken();
          await rpc('santa_issue_token', { p_session_hash: adminHash, p_participant_id: id, p_token_hash: await hash(token), p_revision: event.revision });
          // One token, for one explicit participant. Never list or return a batch.
          return response({ token });
        }
        case 'reveal-assignment': {
          await limit('reveal-global', 120, 60);
          return response(await rpc('santa_reveal', { p_token_hash: await hash(strongToken(body.token)) }));
        }
        default: {
          let data;
          switch (operation) {
            case 'create-household': data = { name: text(body.name, 60, 'Household name') }; break;
            case 'rename-household': data = { id: uuid(body.id), name: text(body.name, 60, 'Household name') }; break;
            case 'delete-household': case 'remove-participant': data = { id: uuid(body.id) }; break;
            case 'set-registration': if (typeof body.locked !== 'boolean') throw new ApiError('A lock setting is required.'); data = { locked: body.locked }; break;
            case 'reset-event': if (body.confirmation !== 'RESET EVENT') throw new ApiError('Type RESET EVENT exactly to confirm.'); data = { confirmation: body.confirmation }; break;
            default: throw new ApiError('Unknown endpoint.', 404);
          }
          await rpc('santa_admin_change', { p_session_hash: adminHash, p_action: operation === 'reset-event' ? 'reset' : operation, p_data: data });
          return response({ ok: true });
        }
      }
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      return response({ error: error instanceof ApiError ? error.message : 'The request could not be completed. Please try again.' }, status);
    }
  };
}
