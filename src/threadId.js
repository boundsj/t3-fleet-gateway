/** Shared by server boundaries and the dashboard. T3 joins branded ids with colons and encodeURIComponent components. */
export const MAX_THREAD_ID_CHARS = 2048;
const THREAD_ID = /^(?:[A-Za-z0-9._:!~*'()-]|%[A-Fa-f0-9]{2})+$/;
const PREFIX = 't3-thread://v1/';
const V2_PREFIX = 't3-thread://v2/';

export function isThreadId(value) {
  return typeof value === 'string' && value.length <= MAX_THREAD_ID_CHARS && value.trim() === value &&
    value !== '.' && value !== '..' && THREAD_ID.test(value);
}

/** Preserve colon delimiters in existing MCP links; escape literal percent signs and URI/Markdown punctuation. */
export function threadLink(value) {
  return isThreadId(value) ? PREFIX + encodeURIComponent(value).replaceAll('%3A', ':').replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`) : null;
}

export function isThreadLink(value) {
  if (typeof value === 'string' && value.startsWith(V2_PREFIX)) {
    if (value.length > V2_PREFIX.length + 2 * MAX_THREAD_ID_CHARS + 1) return false;
    const segments = value.slice(V2_PREFIX.length).split('/');
    // Upstream writes both ids as-is, including opaque percent escapes. Reject URL-normalized dot paths too.
    return segments.length === 2 && segments.every((id) => isThreadId(id) && !/^\.{1,2}$/.test(id.replace(/%2e/gi, '.')));
  }
  if (typeof value !== 'string' || value.length > PREFIX.length + 3 * MAX_THREAD_ID_CHARS || !value.startsWith(PREFIX)) return false;
  try {
    const id = decodeURIComponent(value.slice(PREFIX.length));
    return threadLink(id) === value;
  } catch {
    return false;
  }
}

/** Unwrap MCP markdown/autolinks at the response boundary; custom-scheme URLs must pass the strict shared validator. */
export function threadLinkTarget(link) {
  if (link == null || /[\u0000-\u001f\u007f-\u009f]/.test(link)) return null;
  const text = link.trim();
  const target = /^<([^<>\s]+)>$/.exec(text)?.[1] ?? /\]\(([^()\s]+)\)$/.exec(text)?.[1] ?? text;
  if (isThreadLink(target)) return target;
  if (target.length > 2048) return null;
  try {
    return ['https:', 'http:'].includes(new URL(target).protocol) ? target : null;
  } catch {
    return null;
  }
}
