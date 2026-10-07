import { isLoopbackHostname } from '../config.ts';

export const MAX_REDIRECT_URIS = 5;
export const MAX_REDIRECT_URI_LENGTH = 512;

/**
 * Registration rule for redirect URIs: any https URI, or http on a loopback host (native and CLI
 * clients). No fragments, no embedded credentials, no other schemes. Returns a reason when invalid.
 */
export function redirectUriProblem(uri: string): string | undefined {
  if (uri.length > MAX_REDIRECT_URI_LENGTH) return `longer than ${MAX_REDIRECT_URI_LENGTH} characters`;
  if (/[\s\u0000-\u001f\u007f]/.test(uri)) return 'contains whitespace or control characters';
  if (uri.includes('#')) return 'must not contain a fragment';
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return 'is not an absolute URL';
  }
  if (url.username || url.password) return 'must not contain credentials';
  if (url.protocol === 'https:') return undefined;
  if (url.protocol === 'http:') return isLoopbackHostname(url.hostname) ? undefined : 'http is allowed only for loopback hosts';
  return `scheme ${url.protocol} is not allowed`;
}
