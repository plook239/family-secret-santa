import { ApiError, encoder, hash, randomToken } from './security.js';

export function emailSettings(env) {
  const apiKey = env('RESEND_API_KEY');
  const from = env('EMAIL_FROM');
  let site;
  try { site = new URL(env('PUBLIC_SITE_URL')); } catch { /* Validated below. */ }
  if (!apiKey || !/^re_[A-Za-z0-9_-]+$/.test(apiKey) || apiKey.includes('REPLACE') ||
    !from || from.length > 254 || /[\r\n\x00-\x1f\x7f]/.test(from) ||
    !/^(?:[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+|[^<>]+ <[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>)$/.test(from) ||
    !site || site.protocol !== 'https:' || site.username || site.password || site.search || site.hash || !site.pathname.endsWith('/')) {
    throw new ApiError('Email is not configured. Set RESEND_API_KEY, EMAIL_FROM and PUBLIC_SITE_URL in Supabase secrets. The assignments are safe.', 503);
  }
  return { apiKey, from, site };
}
export const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);

// This function receives the giver only, never their recipient or the assignment list.
export function invitation({ name, email }, token, { from, site }) {
  const link = new URL(`reveal.html#/reveal/${token}`, site).href;
  const safeName = escapeHtml(name); const safeLink = escapeHtml(link);
  return {
    from, to: [email], subject: 'Your Secret Santa assignment is ready 🎄',
    text: `Hi ${name},\n\nThe Secret Santa draw is complete.\n\nYour assignment is waiting for you — click below when you're ready to reveal it.\n\n${link}\n\nThis private link is just for you. Please do not forward it.\n\nKeep it secret. Keep it festive.\n\nFamily Secret Santa`,
    html: `<!doctype html><html lang="en"><body style="margin:0;background:#f7f2e6;color:#173e32;font-family:Georgia,serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="100%" style="max-width:560px;background:#fffdf8;border:1px solid #d8c79b;border-radius:16px"><tr><td style="padding:32px"><p style="color:#9c4242;font-size:14px;letter-spacing:2px">FAMILY SECRET SANTA</p><h1 style="font-size:30px;line-height:1.3">A little Christmas mystery 🎄</h1><p style="font-size:18px">Hi ${safeName},</p><p style="font-size:18px;line-height:1.6">The Secret Santa draw is complete.</p><p style="font-size:18px;line-height:1.6">Your assignment is waiting for you — click below when you're ready to reveal it.</p><p style="margin:28px 0"><a href="${safeLink}" style="display:inline-block;padding:16px 24px;background:#173e32;color:#fffdf8;border-radius:8px;text-decoration:none;font-size:18px">Reveal My Secret Santa</a></p><p style="font-size:14px;line-height:1.6">This private link is just for you. Please do not forward it.</p><p style="font-size:16px;line-height:1.6">Keep it secret. Keep it festive.</p><p style="color:#9c4242">Family Secret Santa</p><p style="font-size:12px;overflow-wrap:anywhere">Button not working? Copy this link into your browser:<br><a href="${safeLink}" style="color:#173e32">${safeLink}</a></p></td></tr></table></td></tr></table></body></html>`
  };
}

// Separate HKDF domain from login/session authentication. No extra secret is required.
// Keep ADMIN_PASSWORD unchanged while queued invitations need retrying.
async function payloadKey(password) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name:'HKDF', hash:'SHA-256', salt:encoder.encode('family-secret-santa-email-v1'),
    info:encoder.encode('encrypted-resend-outbox') }, material, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']);
}
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2,'0')).join('');
const bytes = value => new Uint8Array(value.match(/../g).map(s => parseInt(s,16)));
export async function encryptInvitation(payload, password, deliveryId) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name:'AES-GCM', iv, additionalData:encoder.encode(deliveryId) },
    await payloadKey(password), encoder.encode(JSON.stringify(payload)));
  return `v1.${hex(iv)}.${hex(new Uint8Array(encrypted))}`;
}
export async function decryptInvitation(ciphertext, password, deliveryId) {
  try {
    if (!/^v1\.[a-f0-9]{24}\.[a-f0-9]+$/.test(ciphertext)) throw new Error();
    const [, iv, encrypted] = ciphertext.split('.');
    const result = await crypto.subtle.decrypt({ name:'AES-GCM', iv:bytes(iv), additionalData:encoder.encode(deliveryId) },
      await payloadKey(password), bytes(encrypted));
    return JSON.parse(new TextDecoder().decode(result));
  } catch { throw new ApiError('A queued email cannot be opened. The organizer password may have changed; use a manual replacement link for this participant.', 503); }
}

// Bounded requests avoid hosted Edge wall-clock limits. The UI continues pending batches.
export async function deliverEmails(rpc, env, fetchApi, { batchSize = 20, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let settings;
  try { settings = emailSettings(env); }
  catch (error) { return { emailDelivery:await rpc('santa_email_summary'), emailError:error.message }; }
  const attempted = []; let emailError; const started = Date.now();
  for (let i = 0; i < batchSize; i++) {
    if (Date.now() - started > 30000) break;
    const row = await rpc('santa_claim_email', { p_exclude:attempted });
    if (!row) break;
    attempted.push(row.participantId);
    const ids = { p_participant_id:row.participantId, p_lease_id:row.leaseId };
    let payload;
    try {
      if (row.encryptedPayload) payload = await decryptInvitation(row.encryptedPayload, env('ADMIN_PASSWORD'), row.deliveryId);
      else {
        const token = randomToken(); payload = invitation(row, token, settings);
        await rpc('santa_prepare_email', { ...ids, p_token_hash:await hash(token),
          p_encrypted_payload:await encryptInvitation(payload, env('ADMIN_PASSWORD'), row.deliveryId) });
      }
    } catch (error) {
      emailError = error instanceof ApiError ? error.message : 'Email preparation failed. The assignments are safe; retry email delivery.';
      await rpc('santa_finish_email', { ...ids, p_message_id:null, p_error:emailError, p_definite_failure:false });
      break;
    }
    // Persist the attempt BEFORE Resend: a lost response is an uncertain send, never a new token.
    await rpc('santa_begin_email_attempt', ids);
    let messageId = null; let error; let definite = false; let stop = false;
    try {
      const response = await fetchApi('https://api.resend.com/emails', { method:'POST',
        headers:{ Authorization:`Bearer ${settings.apiKey}`, 'Content-Type':'application/json', 'Idempotency-Key':`santa/${row.deliveryId}` },
        body:JSON.stringify(payload), signal:AbortSignal.timeout(10000) });
      const result = await response.json().catch(() => null);
      if (response.ok && typeof result?.id === 'string' && /^[a-zA-Z0-9-]{1,200}$/.test(result.id)) messageId = result.id;
      else {
        // Never persist/return provider text: it can contain addresses or request secrets.
        definite = response.status >= 400 && response.status < 500 && response.status !== 409;
        error = response.status === 401 || response.status === 403 ? 'Resend rejected the API key or sender. Check the key, permissions and verified sending domain.'
          : response.status === 429 ? 'Resend rate or quota limit reached. Wait before retrying failed emails.'
          : 'Resend did not accept this email. Check Resend and retry; assignments are unchanged.';
        stop = [401,403,409,429].includes(response.status);
      }
    } catch { error = 'Resend could not be reached or its response was lost. Retry safely within 23 hours.'; }
    await rpc('santa_finish_email', { ...ids, p_message_id:messageId, p_error:error ?? null, p_definite_failure:definite });
    if (error) emailError = error;
    if (stop) break;
    if (i + 1 < batchSize) await pause(600); // Stay below Resend's default 2 requests/second.
  }
  return { emailDelivery:await rpc('santa_email_summary'), ...(emailError ? { emailError } : {}) };
}
