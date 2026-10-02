import { createSupabaseService } from './supabase-service.js';
import { config } from './config.js';
const local = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
// Optional local-only demo override for the UI test harness. Never on GitHub Pages.
const demo = local && (config.mode === 'demo' || new URLSearchParams(location.search).get('demo') === '1');
// Keep demo code and the solver out of the production module graph.
const demoService = demo ? (await import('./demo-service.js')).createDemoService({
  getItem: key => window.localStorage.getItem(key), setItem: (key, value) => window.localStorage.setItem(key, value)
}, globalThis.crypto) : null;
export const service = demo ? Object.assign(demoService, {
  isDemo: true, isAuthenticated: () => true, getAdminEvent: () => demoService.getEvent()
}) : createSupabaseService(config, {
  onAuthRequired: () => window.dispatchEvent(new Event('admin-auth-required'))
});
const description = demo ? 'Local preview · Data stays in this browser. Reveal links work only here. Browser storage is not private.' : 'Our family gift exchange · Keep your personal reveal link private.';
document.querySelectorAll('.demo-note').forEach(node => { node.textContent = description; });
const modeNote = document.querySelector('#mode-note');
if (modeNote) { modeNote.hidden = !demo; modeNote.textContent = 'Local preview: no authentication. Use sample information only.'; }
