import '../tlsTrust.ts';
import { SECOND } from '../time.ts';
import { SUPPORTED_SCOPES } from './scopes.ts';

/** RFC 8414 authorization server metadata. The issuer is the gateway's public origin. */
export function authorizationServerMetadata(publicUrl: string): Record<string, unknown> {
  return {
    issuer: publicUrl,
    authorization_endpoint: `${publicUrl}/oauth/authorize`,
    token_endpoint: `${publicUrl}/oauth/token`,
    registration_endpoint: `${publicUrl}/oauth/register`,
    scopes_supported: SUPPORTED_SCOPES,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
  };
}

/** Names this gateway in its protected-resource metadata; `doctor` relies on it to tell the gateway from other servers. */
export const RESOURCE_NAME = 't3-fleet-gateway';

/** RFC 9728 protected resource metadata for the MCP endpoint. */
export function protectedResourceMetadata(publicUrl: string): Record<string, unknown> {
  return {
    resource: `${publicUrl}/mcp`,
    authorization_servers: [publicUrl],
    scopes_supported: SUPPORTED_SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: RESOURCE_NAME,
  };
}

export function resourceMetadataUrl(publicUrl: string): string {
  return `${publicUrl}/.well-known/oauth-protected-resource/mcp`;
}

/** What the public URL answered for this gateway's protected resource metadata (doctor and the dashboard's checks). */
export type PublicUrlProbe =
  | { outcome: 'ok' }
  | { outcome: 'http_error'; status: number }
  | { outcome: 'wrong_resource'; resource: string }
  | { outcome: 'different_server'; resourceName: string }
  | { outcome: 'unreachable'; errorName: string };

/** Fetch the public URL's resource metadata and check it is this gateway's, for `resource`. Never throws. */
export async function probePublicUrl(publicUrl: string, resource: string): Promise<PublicUrlProbe> {
  try {
    const response = await fetch(resourceMetadataUrl(publicUrl), { signal: AbortSignal.timeout(5 * SECOND) });
    if (!response.ok) return { outcome: 'http_error', status: response.status };
    const body = (await response.json()) as { resource?: unknown; resource_name?: unknown };
    if (body.resource !== resource) return { outcome: 'wrong_resource', resource: String(body.resource) };
    // Any MCP server behind the same URL (T3 itself, behind another proxy) names the same resource.
    if (body.resource_name !== RESOURCE_NAME) return { outcome: 'different_server', resourceName: String(body.resource_name) };
    return { outcome: 'ok' };
  } catch (error) {
    return { outcome: 'unreachable', errorName: (error as Error).name };
  }
}
