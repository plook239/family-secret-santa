export const $ = selector => document.querySelector(selector);
export function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
export function message(text, error = false) {
  const node = $('#message'); node.textContent = text; node.className = error ? 'notice error' : 'notice'; node.hidden = !text;
}
export async function action(work) {
  try { await work(); } catch (error) { message(error.message, true); }
}
