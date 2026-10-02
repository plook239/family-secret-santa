import { service } from './service.js';
import { $, message, action } from './common.js';
function hide() {
  $('#result').hidden = true; $('#giver').textContent = ''; $('#recipient').textContent = '';
  $('#reveal-button').hidden = false;
}
function route() {
  hide(); message('');
  const validFormat = /^#\/reveal\/[a-f0-9]{64}$/.test(location.hash);
  $('#reveal-button').disabled = !validFormat;
  if (!validFormat) message('Open the personal reveal link your organizer gave you.', true);
}
$('#reveal-button').addEventListener('click', () => action(async () => {
  const hash = location.hash; const button = $('#reveal-button'); button.disabled = true;
  try {
    const result = await service.reveal(hash.slice('#/reveal/'.length));
    if (hash !== location.hash) return;
    message(''); $('#giver').textContent = result.participantName; $('#recipient').textContent = result.recipientName;
    button.hidden = true; $('#result').hidden = false; $('#result').focus();
  } finally { button.disabled = false; }
}));
$('#hide-result').addEventListener('click', () => { hide(); $('#reveal-button').focus(); });
window.addEventListener('hashchange', route);
window.addEventListener('storage', route);
// Clear a restored secret on back/forward cache entry, not during initial load.
window.addEventListener('pageshow', event => { if (event.persisted) route(); });
route();
