import type { OAuthClientProvider } from '@modelcontextprotocol/client';
import { CALLBACK, hiddenFields } from './oauthFlow.ts';

type ProviderTypes = Parameters<OAuthClientProvider['saveTokens']>[0];
type ClientInfo = Parameters<NonNullable<OAuthClientProvider['saveClientInformation']>>[0];
type DiscoveryState = Parameters<NonNullable<OAuthClientProvider['saveDiscoveryState']>>[0];

/**
 * An OAuthClientProvider like a hosted agent's: the SDK discovers metadata, registers, builds the
 * PKCE authorization URL and refreshes tokens. "Redirecting the user" here means loading the
 * approval page and submitting it with an approval code, as the operator would.
 */
export class TestAgentProvider implements OAuthClientProvider {
  clientInfo: ClientInfo | undefined;
  savedTokens: ProviderTypes | undefined;
  callbackParams: URLSearchParams | undefined;
  #verifier = '';
  #discovery: DiscoveryState | undefined;
  readonly #approve: () => string;
  readonly #access: 'read' | 'operate';

  constructor(approve: () => string, access: 'read' | 'operate' = 'read') {
    this.#approve = approve;
    this.#access = access;
  }

  get redirectUrl(): string {
    return CALLBACK;
  }

  get clientMetadata() {
    return {
      client_name: 'SDK test agent',
      redirect_uris: [CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  clientInformation() {
    return this.clientInfo;
  }

  saveClientInformation(info: ClientInfo) {
    this.clientInfo = info;
  }

  tokens() {
    return this.savedTokens;
  }

  saveTokens(tokens: ProviderTypes) {
    this.savedTokens = tokens;
  }

  saveCodeVerifier(verifier: string) {
    this.#verifier = verifier;
  }

  codeVerifier() {
    return this.#verifier;
  }

  saveDiscoveryState(state: DiscoveryState) {
    this.#discovery = state;
  }

  discoveryState() {
    return this.#discovery;
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    const page = await fetch(url);
    if (page.status !== 200) throw new Error(`approval page returned ${page.status}`);
    const fields = hiddenFields(await page.text());
    const decision = await fetch(new URL('/oauth/authorize', url), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...fields, approval_code: this.#approve(), access: this.#access, decision: 'approve' }),
    });
    this.callbackParams = new URL(decision.headers.get('location') ?? '').searchParams;
  }
}
