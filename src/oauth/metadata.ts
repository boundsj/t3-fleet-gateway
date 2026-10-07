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

/** RFC 9728 protected resource metadata for the MCP endpoint. */
export function protectedResourceMetadata(publicUrl: string): Record<string, unknown> {
  return {
    resource: `${publicUrl}/mcp`,
    authorization_servers: [publicUrl],
    scopes_supported: SUPPORTED_SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 't3-fleet-gateway',
  };
}

export function resourceMetadataUrl(publicUrl: string): string {
  return `${publicUrl}/.well-known/oauth-protected-resource/mcp`;
}
