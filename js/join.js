import { service } from './service.js';
import { $, action, message } from './common.js';
if (location.hash.startsWith('#/reveal/')) location.replace(`reveal.html${service.isDemo ? '?demo=1' : ''}${location.hash}`);
async function refresh() {
  const event = await service.getEvent();
  const select = $('#household'); const selected = select.value;
  select.replaceChildren(new Option('Choose your household', ''));
  for (const household of event.households) select.append(new Option(household.name, household.id));
  select.value = selected;
  $('#join-fields').disabled = event.locked || event.drawn || !event.households.length;
  $('#join-status').textContent = event.drawn ? 'The names have been drawn! Look out for your personal reveal link from the organizer.' : event.locked ? 'The family list is closed for now. Contact your organizer if you need a hand.' : !event.households.length ? 'The organizer is setting up our households. Come back soon to put your name in the hat.' : 'A few details, and you’re part of the magic.';
}
$('#join-form').addEventListener('submit', e => {
  e.preventDefault(); action(async () => {
    const button = $('#join-form button'); button.disabled = true;
    try {
      const result = await service.join(Object.fromEntries(new FormData(e.target)));
      message(''); $('#confirmed-name').textContent = result.name;
      $('#join-form').hidden = true; $('#join-status').hidden = true;
      $('#confirmation').hidden = false; $('#confirmation').focus(); e.target.reset();
    } finally { button.disabled = false; }
  });
});
$('#another').addEventListener('click', () => action(async () => {
  await refresh(); $('#confirmation').hidden = true; $('#join-form').hidden = false; $('#join-status').hidden = false; $('#name').focus();
}));
window.addEventListener('storage', () => action(refresh));
window.addEventListener('hashchange', () => { if (location.hash.startsWith('#/reveal/')) location.replace(`reveal.html${service.isDemo ? '?demo=1' : ''}${location.hash}`); });
action(refresh);
