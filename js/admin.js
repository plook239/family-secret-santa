import { service } from './service.js';
import { $, element, action, message } from './common.js';
let emailBusy = false;
function button(text, handler, disabled = false, className = 'secondary') {
  const node = element('button', text, className); node.type = 'button'; node.disabled = disabled;
  node.addEventListener('click', () => action(handler)); return node;
}
async function change(work, success) { await work(); await refresh(); message(success); }
async function refresh() {
  const event = await service.getAdminEvent();
  $('#login-section').hidden = true; $('#admin-content').hidden = false;
  $('#session-controls').hidden = service.isDemo;
  if (service.isDemo) $('#link-instructions').textContent = 'Local demo: share each link only with its named participant. These links work only in this browser; no emails are sent.';
  $('#household-form button').disabled = event.drawn;
  $('#household-name').disabled = event.drawn;
  $('#households').replaceChildren();
  if (!event.households.length) $('#households').append(element('p', 'Start by adding the family’s households.', 'field-note'));
  for (const household of event.households) {
    const count = event.participants.filter(p => p.householdId === household.id).length;
    const row = element('div', undefined, 'item'); const form = element('form', undefined, 'household-edit');
    const label = element('label', 'Household name'); const input = element('input'); input.id = `household-${household.id}`;
    input.value = household.name; input.required = true; input.maxLength = 60; input.disabled = event.drawn; label.htmlFor = input.id;
    const save = element('button', 'Rename', 'secondary'); save.disabled = event.drawn;
    form.append(label, input, save, element('p', `${count} ${count === 1 ? 'participant' : 'participants'}`, 'field-note'));
    form.addEventListener('submit', e => { e.preventDefault(); action(() => change(() => service.saveHousehold({ id: household.id, name: input.value }), 'Household renamed.')); });
    row.append(form, button(`Delete ${household.name}`, () => change(() => service.deleteHousehold(household.id), 'Empty household deleted.'), event.drawn || count > 0));
    $('#households').append(row);
  }
  $('#count').textContent = event.participants.length;
  $('#participants-empty').hidden = event.participants.length > 0;
  $('#participants').replaceChildren();
  for (const participant of event.participants) {
    const row = element('li', undefined, 'item'); const info = element('div', undefined, 'info');
    info.append(element('strong', participant.name), element('p', participant.email), element('p', event.households.find(h => h.id === participant.householdId)?.name ?? 'Unknown household'));
    row.append(info, button(`Remove ${participant.name}`, async () => {
      if (window.confirm(`Remove ${participant.name} from the family list?`)) await change(() => service.removeParticipant(participant.id), 'Participant removed.');
    }, event.drawn)); $('#participants').append(row);
  }
  $('#lock').textContent = event.locked ? 'Reopen registration' : 'Close registration'; $('#lock').disabled = event.drawn;
  $('#generate').disabled = event.drawn || !event.locked || event.participants.length < 2;
  $('#open-reset').disabled = false;
  $('#draw-status').textContent = event.drawn ? 'Names drawn successfully. Everyone has one recipient from another household. The event is frozen; pairings stay hidden here.' : event.locked ? 'Registration is closed. Review your family list, then draw the names.' : 'Registration is open. Finish gathering the family, then close registration to draw.';
  $('#email-section').hidden = service.isDemo || !event.drawn;
  const delivery = event.emailDelivery ?? {};
  $('#email-status').textContent = `Assignments generated successfully. Emails sent: ${delivery.sent ?? 0}. Emails failed: ${delivery.failed ?? 0}. Waiting: ${delivery.pending ?? 0}. Sending: ${delivery.sending ?? 0}. Needs review: ${delivery.uncertain ?? 0}. Manual replacements: ${delivery.cancelled ?? 0}.`;
  $('#email-problems').replaceChildren();
  for (const problem of delivery.problems ?? []) $('#email-problems').append(element('li', `${problem.name}: ${problem.error ?? 'Check delivery in Resend.'}`));
  $('#retry-emails').hidden = !(delivery.failed || delivery.pending || delivery.sending);
  $('#retry-emails').disabled = emailBusy;
  $('#refresh-emails').disabled = emailBusy;
  $('#links-section').hidden = !event.drawn;
  $('#reveal-links').replaceChildren();
  // Tokens are delivery credentials; recipient names never enter this page.
  for (const link of await service.getRevealLinks()) {
    const row = element('div', undefined, 'item'); const info = element('div', undefined, 'info');
    info.append(element('strong', link.name), element('p', link.email));
    if (!service.isDemo) {
      const create = button(link.linkIssued ? 'Replace reveal link' : 'Create reveal link', async () => {
        if (link.linkIssued && !window.confirm(`Replace ${link.name}’s reveal link? Their old link, including the emailed invitation, will stop working. Any unsent invitation will be cancelled.`)) return;
        create.disabled = true;
        try {
          const { token } = await service.issueRevealLink(link.participantId);
          const url = new URL(`reveal.html#/reveal/${token}`, document.baseURI).href;
          link.linkIssued = true; create.textContent = 'Replace reveal link';
          input.value = url; label.hidden = false; input.hidden = false; copy.hidden = false;
          message(`Link created for ${link.name}. Copy it now and share it privately.`);
        } finally { create.disabled = false; }
      });
      const label = element('label', `Reveal link for ${link.name}`);
      const input = element('input'); input.id = `link-${link.participantId}`; label.htmlFor = input.id; input.readOnly = true;
      input.addEventListener('focus', () => input.select());
      const copy = button('Copy link', async () => {
        try { await navigator.clipboard.writeText(input.value); message(`Reveal link copied for ${link.name}.`); }
        catch { input.focus(); input.select(); message('Select and copy this link manually.', true); }
      });
      label.hidden = true; input.hidden = true; copy.hidden = true;
      row.append(info, create, copy, label, input); $('#reveal-links').append(row); continue;
    }
    const url = new URL(`reveal.html?demo=1#/reveal/${link.token}`, document.baseURI).href;
    const label = element('label', `Reveal link for ${link.name}`); const input = element('input');
    input.id = `link-${link.token}`; label.htmlFor = input.id; input.value = url; input.readOnly = true;
    input.addEventListener('focus', () => input.select());
    row.append(info, button('Copy link', async () => {
      try { await navigator.clipboard.writeText(url); message(`Reveal link copied for ${link.name}.`); }
      catch { input.focus(); input.select(); message('Select and copy the link manually. Clipboard access is unavailable.', true); }
    }), label, input); $('#reveal-links').append(row);
  }
}
$('#household-form').addEventListener('submit', e => { e.preventDefault(); action(async () => {
  await change(() => service.saveHousehold({ name: $('#household-name').value }), 'Household added.'); e.target.reset();
}); });
$('#lock').addEventListener('click', () => action(async () => {
  const event = await service.getAdminEvent(); await change(() => service.setLocked(!event.locked), event.locked ? 'Registration reopened.' : 'Registration closed.');
}));
$('#generate').addEventListener('click', () => action(async () => {
  $('#generate').disabled = true;
  emailBusy = true;
  try {
    message(service.isDemo ? 'Drawing the names…' : 'Drawing the names and sending private invitations…');
    await finishEmailBatches(await service.generate());
  }
  catch (error) { await refresh(); throw error; }
  finally { emailBusy = false; await refresh(); }
}));
async function finishEmailBatches(result) {
  // Bounded backend batches preserve progress across reloads. Stop on provider failures.
  for (let batch = 0; batch < 20 && result?.emailDelivery?.pending > 0 && !result.emailError; batch++) {
    await refresh();
    result = await service.retryFailedEmails();
  }
  await refresh();
  message(result?.emailError ?? (service.isDemo ? 'The names are drawn! Share the personal reveal links below.' : 'Assignments generated successfully. Email delivery status is shown below.'), !!result?.emailError);
}
$('#retry-emails').addEventListener('click', () => action(async () => {
  if (emailBusy) return;
  emailBusy = true; $('#retry-emails').disabled = true;
  message('Sending unsent private invitations. Your assignments stay the same…');
  try { await finishEmailBatches(await service.retryFailedEmails()); }
  finally { emailBusy = false; await refresh(); }
}));
$('#refresh-emails').addEventListener('click', () => action(refresh));
$('#open-reset').addEventListener('click', () => { $('#reset-form').reset(); $('#reset-dialog').showModal(); $('#reset-confirmation').focus(); });
$('#cancel-reset').addEventListener('click', () => $('#reset-dialog').close());
$('#reset-form').addEventListener('submit', e => { e.preventDefault(); action(async () => {
  await service.reset($('#reset-confirmation').value); $('#reset-dialog').close(); await refresh(); message('Draw cleared, old links invalidated, and registration reopened.');
}); });
window.addEventListener('storage', () => { if (service.isAuthenticated()) action(refresh); });
function showLogin() {
  $('#admin-content').hidden = true; $('#session-controls').hidden = true; $('#login-section').hidden = false;
  $('#participants').replaceChildren(); $('#households').replaceChildren(); $('#reveal-links').replaceChildren();
  $('#reset-dialog').close();
}
window.addEventListener('admin-auth-required', showLogin);
$('#login-form').addEventListener('submit', e => { e.preventDefault(); action(async () => {
  const button = $('#login-form button'); button.disabled = true;
  const password = $('#admin-password').value; $('#admin-password').value = '';
  try { await service.login(password); message(''); await refresh(); } finally { button.disabled = false; }
}); });
$('#logout').addEventListener('click', () => action(async () => { await service.logout(); message('Signed out.'); }));
if (service.isAuthenticated()) action(refresh); else showLogin();
window.addEventListener('pageshow', event => {
  if (event.persisted) { if (service.isAuthenticated()) action(refresh); else showLogin(); }
});
