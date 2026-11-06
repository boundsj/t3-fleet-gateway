import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import { startTestGateway } from './helpers/gateway.ts';
import { FakeDocument, type FakeNode } from './helpers/fakeDom.ts';
import { authorizeUrl, CALLBACK, loadApprovalPage, pkcePair, registerClient, standardAuthorizeParams, tokenRequest } from './helpers/oauthFlow.ts';
import { browserLinkHandle, OWNER_BASE, OWNER_HOST, OWNER_ORIGIN, OwnerBrowser, SoftwarePasskey } from './helpers/passkey.ts';

/**
 * The owner page (src/dashboard/assets/owner.js) running against the real dashboard listener: a fake DOM with no HTML
 * parser, a window whose fetch is a same-origin browser with a cookie jar, and a software passkey behind
 * navigator.credentials. Covers the routine path a person takes: Connect, the approval page's link, passkey sign-in,
 * explicit Allow, and the navigation back to the client with a code the client exchanges with its PKCE verifier.
 */

interface OwnerPage {
  boot(win: unknown, doc: FakeDocument): { ready: Promise<void>; model: Record<string, unknown> };
  safeReturn(url: string, origin: string): boolean;
  parseOwnerRoute(hash: string): { view: string; handle: string | null };
  toBase64Url(buffer: ArrayBuffer): string;
  fromBase64Url(text: string): ArrayBuffer;
}

const page = (await import(pathToFileURL(new URL('../src/dashboard/assets/owner.js', import.meta.url).pathname).href)) as OwnerPage;

const toBuffer = (base64url: string): ArrayBuffer => {
  const bytes = Buffer.from(base64url, 'base64url');
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};
const fromBuffer = (buffer: ArrayBuffer): string => Buffer.from(buffer).toString('base64url');

class OwnerWindow {
  readonly location: { hash: string; assigned: string[]; assign(url: string): void };
  readonly listeners = new Map<string, (() => unknown)[]>();
  readonly requests: { path: string; init: RequestInit | undefined }[] = [];
  readonly prompts: Record<string, unknown>[] = [];
  readonly navigator: { credentials: { create(o: { publicKey: Record<string, unknown> }): Promise<unknown>; get(o: { publicKey: Record<string, unknown> }): Promise<unknown> } };

  readonly browser: OwnerBrowser;

  constructor(browser: OwnerBrowser, passkey: SoftwarePasskey, hash: string) {
    this.browser = browser;
    const assigned: string[] = [];
    this.location = { hash, assigned, assign: (url: string) => { assigned.push(url); } };
    this.navigator = { credentials: {
      create: async ({ publicKey }) => {
        this.prompts.push(publicKey);
        const answer = passkey.register(fromBuffer(publicKey.challenge as ArrayBuffer));
        return { rawId: toBuffer(passkey.id), response: { clientDataJSON: toBuffer(answer.clientDataJSON), attestationObject: toBuffer(answer.attestationObject) } };
      },
      get: async ({ publicKey }) => {
        this.prompts.push(publicKey);
        const answer = passkey.assert(fromBuffer(publicKey.challenge as ArrayBuffer));
        return { rawId: toBuffer(answer.id), response: {
          clientDataJSON: toBuffer(answer.clientDataJSON), authenticatorData: toBuffer(answer.authenticatorData), signature: toBuffer(answer.signature) } };
      },
    } };
  }

  async fetch(path: string, init?: RequestInit): Promise<Response> {
    this.requests.push({ path, init });
    assert.match(path, /^api\//, 'the page calls its own API with relative URLs');
    assert.equal((init?.headers as Record<string, string>)['x-t3fg-dashboard'], '1');
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const answer = await this.browser.call(path, body);
    return new Response(answer.body, { status: answer.status, headers: { 'content-type': 'application/json' } });
  }

  addEventListener(event: string, handler: () => unknown): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]);
  }
}

function text(root: FakeNode): string {
  return root.textContent.replaceAll(/\s+/g, ' ');
}

async function click(root: FakeNode, label: string): Promise<void> {
  const button = root.elements('button').find((node) => node.textContent.includes(label));
  assert.ok(button, `button ${label}`);
  for (const handler of button.listeners.get('click') ?? []) await handler({ target: button, preventDefault() {} });
}

function assertSafe(root: FakeNode): void {
  for (const node of root.elements()) {
    assert.ok(!['script', 'iframe', 'object', 'embed', 'style', 'link', 'meta', 'base'].includes(node.tag), `unexpected <${node.tag}>`);
    for (const [name, value] of node.attributes) {
      assert.doesNotMatch(name, /^on/i);
      assert.notEqual(name, 'style');
      assert.notEqual(name, 'action');
      if (name === 'href') assert.match(value, /^#\/[A-Za-z0-9/_-]*$/);
    }
  }
}

async function setup(t: TestContext) {
  const h = await startTestGateway(t, {
    config: {
      hosts: [{ id: 'main', t3Url: 'http://127.0.0.1:9' }, { id: 'studio', t3Url: 'http://127.0.0.1:9' }],
      dashboard: { enabled: true, basePath: OWNER_BASE, allowedHosts: [OWNER_HOST], browserApproval: { enabled: true, origin: OWNER_ORIGIN } },
    },
  });
  return { h, browser: new OwnerBrowser(h.gateway.dashboard!.port), passkey: new SoftwarePasskey() };
}

function mount(win: OwnerWindow): { doc: FakeDocument; root: FakeNode; app: ReturnType<OwnerPage['boot']> } {
  const doc = new FakeDocument();
  const root = doc.createElement('main');
  root.setAttribute('id', 'owner');
  doc.body.append(root);
  const app = page.boot(win, doc);
  return { doc, root, app };
}

test('owner page: enroll a passkey, then approve a generic client from the approval page link', async (t) => {
  const { h, browser, passkey } = await setup(t);

  // First setup: the CLI's enrollment code typed into the page, then the passkey prompt.
  const enrollWindow = new OwnerWindow(browser, passkey, '#/enroll');
  const enroll = mount(enrollWindow);
  await enroll.app.ready;
  assert.match(text(enroll.root), /Set up a passkey/);
  const code = h.services.owner.mintEnrollmentCode().code;
  const codeInput = enroll.root.elements('input').find((node) => node.getAttribute('id') === 'enroll-code')!;
  codeInput.value = code;
  for (const handler of codeInput.listeners.get('input') ?? []) await handler({ target: codeInput });
  const form = enroll.root.elements('form')[0]!;
  for (const handler of form.listeners.get('submit') ?? []) await handler({ target: form, preventDefault() {} });
  const created = enrollWindow.prompts[0]!;
  assert.deepEqual((created.rp as { id: string }).id, OWNER_HOST);
  assert.equal((created.authenticatorSelection as { userVerification: string }).userVerification, 'required');
  assert.equal(created.attestation, 'none');
  assert.match(text(enroll.root), /Signed in/);
  assert.ok(enrollWindow.requests.every((request) => !request.path.includes(code)), 'the code travels in the body, never the URL');
  assert.equal(codeInput.value, code, 'the field keeps what was typed until the page leaves');

  // Routine use: Connect opens the approval page; its link opens the owner page in a browser that must sign in.
  const clientId = await registerClient(h.baseUrl, { client_name: '<img src=x onerror=alert(1)> Generic client' });
  const { verifier, challenge } = pkcePair();
  const approval = await loadApprovalPage(authorizeUrl(h.baseUrl, standardAuthorizeParams(clientId, challenge, { scope: 'fleet:read fleet:operate', state: 'ui-state' })));
  const handle = browserLinkHandle(approval.html)!;
  const routineBrowser = new OwnerBrowser(browser.port);
  const win = new OwnerWindow(routineBrowser, passkey, `#/approve/${handle}`);
  const { root, app } = mount(win);
  await app.ready;
  assert.match(text(root), /Sign in to review a connection request/);
  assert.doesNotMatch(text(root), /Generic client/, 'nothing about the request is shown before sign-in');
  await click(root, 'Sign in with passkey');
  assert.equal((win.prompts[0]!.userVerification), 'required');
  assert.match(text(root), /Allow this agent to connect\?/);
  assert.match(text(root), /<img src=x onerror=alert\(1\)> Generic client/, 'the registered name is shown as text');
  assert.match(text(root), new RegExp(new URL(CALLBACK).origin.replaceAll('.', '\\.')));
  assertSafe(root);
  assert.equal(root.elements('img').length, 0);

  // Narrow the grant to one machine, Read only, then Allow.
  const radio = (name: string, value: string) => root.elements('input').find((node) => node.getAttribute('name') === name && node.getAttribute('value') === value)!;
  for (const handler of radio('access', 'read').listeners.get('change') ?? []) await handler({});
  const studio = root.elements('input').find((node) => node.getAttribute('value') === 'studio')!;
  for (const handler of studio.listeners.get('change') ?? []) await handler({});
  assert.ok(radio('machines', 'selected').attributes.has('checked'));
  await click(root, 'Allow');
  assert.match(text(root), /Access allowed/);
  assert.equal(win.location.assigned.length, 1);
  const location = new URL(win.location.assigned[0]!);
  assert.equal(`${location.origin}${location.pathname}`, CALLBACK);
  assert.equal(location.searchParams.get('state'), 'ui-state');

  // The client finishes with its own verifier.
  const exchanged = await tokenRequest(h.baseUrl, {
    grant_type: 'authorization_code', code: location.searchParams.get('code')!, client_id: clientId, redirect_uri: CALLBACK, code_verifier: verifier,
  });
  assert.equal(exchanged.status, 200);
  assert.equal(((await exchanged.json()) as { scope: string }).scope, 'host:studio:read');
  for (const request of win.requests) assert.equal(request.init?.credentials, 'same-origin');
});

test('owner page: deny, a spent request, and unsafe return addresses', async (t) => {
  const { h, browser, passkey } = await setup(t);
  assert.equal((await browser.enroll(passkey, h.services.owner.mintEnrollmentCode().code)).status, 200);
  const clientId = await registerClient(h.baseUrl);
  const approval = await loadApprovalPage(authorizeUrl(h.baseUrl, standardAuthorizeParams(clientId, pkcePair().challenge)));
  const handle = browserLinkHandle(approval.html)!;
  const win = new OwnerWindow(browser, passkey, `#/approve/${handle}`);
  const { root, app } = mount(win);
  await app.ready;
  await click(root, 'Deny');
  assert.match(text(root), /Access denied/);
  assert.equal(new URL(win.location.assigned[0]!).searchParams.get('error'), 'access_denied');

  const again = new OwnerWindow(browser, passkey, `#/approve/${handle}`);
  const second = mount(again);
  await second.app.ready;
  assert.match(text(second.root), /already answered, expired/);
  assert.equal(again.location.assigned.length, 0);

  assert.equal(page.safeReturn('javascript:alert(1)', 'https://agent.example.com'), false);
  assert.equal(page.safeReturn('https://evil.example.com/cb?code=x', 'https://agent.example.com'), false);
  assert.equal(page.safeReturn('https://agent.example.com/cb?code=x', 'https://agent.example.com'), true);
  assert.deepEqual(page.parseOwnerRoute('#/approve/short'), { view: 'home', handle: null });
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253]).buffer;
  for (let n = 0; n <= 7; n += 1) {
    const slice = bytes.slice(0, n);
    assert.equal(page.toBase64Url(slice), Buffer.from(slice).toString('base64url'));
    assert.deepEqual(Buffer.from(page.fromBase64Url(Buffer.from(slice).toString('base64url'))), Buffer.from(slice));
  }
});

test('owner page: without a passkey it explains setup and offers nothing to approve', async (t) => {
  const { browser, passkey } = await setup(t);
  const win = new OwnerWindow(browser, passkey, `#/approve/${'A'.repeat(43)}`);
  const { root, app } = mount(win);
  await app.ready;
  assert.match(text(root), /Browser approval is not set up/);
  assert.equal(root.elements('button').length, 0);
  assert.deepEqual(win.prompts, []);
});
