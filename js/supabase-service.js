export function createSupabaseService(config, { fetchApi = fetch, sessionStore = {
  // Access lazily so public registration still works if session storage is blocked.
  getItem: key => globalThis.sessionStorage.getItem(key),
  setItem: (key, value) => globalThis.sessionStorage.setItem(key, value),
  removeItem: key => globalThis.sessionStorage.removeItem(key)
}, onAuthRequired = () => {} } = {}) {
  const sessionKey = 'family-secret-santa.admin-session.v1';
  function getSession() {
    try { return sessionStore.getItem(sessionKey); } catch { return null; }
  }
  function clearSession() { try { sessionStore.removeItem(sessionKey); } catch { /* Already unusable. */ } }
  function settings() {
    let url;
    try { url = new URL(config.supabaseUrl); } catch { throw new Error('Set the Supabase project URL and public key in js/config.js before using this app.'); }
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if ((!local && url.protocol !== 'https:') || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use the Supabase project root URL, with HTTPS in production.');
    if (typeof config.publicKey !== 'string' || !config.publicKey) throw new Error('Set your Supabase public key in js/config.js.');
    if (config.publicKey.startsWith('sb_secret_')) throw new Error('A secret key must never be used in the frontend. Use a publishable or anon key.');
    if (!config.publicKey.startsWith('sb_publishable_')) {
      try {
        const part = config.publicKey.split('.')[1];
        const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
        if (payload.role !== 'anon') throw new Error();
      } catch { throw new Error('Use a Supabase publishable key or legacy anon key, never a service-role key.'); }
    }
    return url.origin;
  }
  async function call(endpoint, data = {}, admin = false) {
    const url = settings(); const headers = { 'Content-Type': 'application/json', apikey: config.publicKey };
    if (admin) {
      const session = getSession();
      if (!session) { onAuthRequired(); throw new Error('Please sign in as the organizer.'); }
      headers['X-Admin-Session'] = session;
    }
    let response;
    try { response = await fetchApi(`${url}/functions/v1/${endpoint}`, { method: 'POST', headers, body: JSON.stringify(data), cache: 'no-store', credentials: 'omit' }); }
    catch { throw new Error('Could not reach the family app. Check your connection and the allowed origins in Supabase.'); }
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401 && admin) { clearSession(); onAuthRequired(); }
      throw new Error(result?.error ?? 'The server could not complete this request. Please try again.');
    }
    if (result === null) throw new Error('The server returned an invalid response. Please try again.');
    return result;
  }
  return {
    isDemo: false,
    isAuthenticated: () => !!getSession(),
    async login(password) {
      const result = await call('admin-login', { password });
      try { sessionStore.setItem(sessionKey, result.sessionToken); }
      catch { throw new Error('Allow browser session storage to sign in.'); }
    },
    async logout() { try { if (getSession()) await call('admin-logout', {}, true); } finally { clearSession(); onAuthRequired(); } },
    getEvent: () => call('public-event'),
    getAdminEvent: () => call('admin-data', {}, true),
    join: data => call('register-participant', data),
    saveHousehold: ({ id, name }) => call(id ? 'rename-household' : 'create-household', id ? { id, name } : { name }, true),
    deleteHousehold: id => call('delete-household', { id }, true),
    removeParticipant: id => call('remove-participant', { id }, true),
    setLocked: locked => call('set-registration', { locked }, true),
    generate: () => call('generate-assignments', {}, true),
    retryFailedEmails: () => call('retry-failed-emails', {}, true),
    reset: confirmation => call('reset-event', { confirmation }, true),
    reveal: token => call('reveal-assignment', { token }),
    async getRevealLinks() {
      const event = await call('admin-data', {}, true);
      return event.drawn ? event.participants.map(p => ({ participantId: p.id, name: p.name, email: p.email, linkIssued: p.linkIssued })) : [];
    },
    issueRevealLink: participantId => call('issue-reveal-token', { participantId }, true)
  };
}
