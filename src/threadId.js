/** Shared by server boundaries and the dashboard. T3 joins branded ids with colons and encodeURIComponent components. */
export const MAX_THREAD_ID_CHARS = 2048;
const THREAD_ID = /^(?:[A-Za-z0-9._:!~*'()-]|%[A-Fa-f0-9]{2})+$/;
const PREFIX = 't3-thread://v1/';

export function isThreadId(value) {
  return typeof value === 'string' && value.length <= MAX_THREAD_ID_CHARS && value !== '.' && value !== '..' && THREAD_ID.test(value);
}

/** Preserve colon delimiters in existing MCP links; escape literal percent signs and URI/Markdown punctuation. */
export function threadLink(value) {
  return isThreadId(value) ? PREFIX + encodeURIComponent(value).replaceAll('%3A', ':').replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`) : null;
}

export function isThreadLink(value) {
  if (typeof value !== 'string' || value.length > PREFIX.length + 3 * MAX_THREAD_ID_CHARS || !value.startsWith(PREFIX)) return false;
  try {
    const id = decodeURIComponent(value.slice(PREFIX.length));
    return threadLink(id) === value;
  } catch {
    return false;
  }
}
