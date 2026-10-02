export class ApiError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const encoder = new TextEncoder();
export async function hash(value) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}
function hex(bytes) { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
export function randomToken() { return hex(crypto.getRandomValues(new Uint8Array(32))); }
export async function sessionHash(token, password) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`santa-admin-session:${token}`))));
}
export async function passwordMatches(input, expected) {
  const [a, b] = await Promise.all([hash(input), hash(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
export function text(value, max, label) {
  if (typeof value !== 'string') throw new ApiError(`${label} is required.`);
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || Array.from(normalized).length > max || /[\u0000-\u001f\u007f]/.test(normalized)) throw new ApiError(`${label} must be 1–${max} characters.`);
  return normalized;
}
export function uuid(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new ApiError('A valid ID is required.');
  return value;
}
export function strongToken(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new ApiError('This reveal link is invalid or has expired.', 404);
  return value;
}
export async function readBody(request) {
  if ((request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') throw new ApiError('Send a JSON request.', 415);
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError('A request body is required.');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 8192) { await reader.cancel(); throw new ApiError('Request too large.', 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error();
    return data;
  } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError('Invalid JSON request.'); }
}
