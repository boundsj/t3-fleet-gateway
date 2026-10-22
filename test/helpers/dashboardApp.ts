import assert from 'node:assert/strict';
import { isThreadLink } from '../../src/threadId.js';
import { pathToFileURL } from 'node:url';
import type { FakeDocument, FakeNode } from './fakeDom.ts';

/** The browser module's exports, typed here (it is plain JavaScript, served as is). */
export interface DashboardApp {
  render(doc: FakeDocument, root: FakeNode, model: Record<string, unknown>, actions: Record<string, (...args: never[]) => unknown>, now?: number): unknown[];
  parseRoute(hash: string): { view: string; id: string | null };
  safeHref(value: unknown): boolean;
  boot(win: FakeWindow, doc: FakeDocument): { ready: Promise<void> };
}

export const APP_URL = new URL('../../src/dashboard/assets/app.js', import.meta.url);
export const VIEWS = ['overview', 'clients', 'hosts', 'jobs', 'checks', 'webhooks'] as const;

/** A browser boundary for the real boot/fetch/form handlers; no storage APIs exist in this harness. */
export class FakeWindow {
  readonly location = { hash: '#/webhooks' };
  readonly crypto = { randomUUID: () => globalThis.crypto.randomUUID() };
  readonly copied: string[] = [];
  readonly navigator = { clipboard: { writeText: async (text: string) => { this.copied.push(text); } } };
  readonly listeners = new Map<string, (() => unknown)[]>();
  fetch: (url: string, init?: RequestInit) => Promise<Response>;

  constructor(fetch: (url: string, init?: RequestInit) => Promise<Response>) { this.fetch = fetch; }
  setTimeout(callback: () => void): void { callback(); }
  setInterval(): void {}
  scrollTo(): void {}
  addEventListener(event: string, handler: () => unknown): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]);
  }
  async dispatch(event: string): Promise<void> {
    for (const handler of this.listeners.get(event) ?? []) await handler();
  }
}

export async function loadApp(): Promise<DashboardApp> {
  return (await import(pathToFileURL(APP_URL.pathname).href)) as DashboardApp;
}

/** Structural checks every rendered tree must pass. */
export function assertSafeTree(root: FakeNode): void {
  for (const node of root.elements()) {
    assert.ok(!['script', 'iframe', 'object', 'embed', 'style', 'link', 'meta', 'base'].includes(node.tag), `unexpected <${node.tag}>`);
    for (const [name, value] of node.attributes) {
      assert.doesNotMatch(name, /^on/i, `event attribute ${name}`);
      assert.notEqual(name, 'style', 'no inline style (blocked by the CSP anyway)');
      assert.notEqual(name, 'action', 'forms submit through the protected JSON API only');
      assert.notEqual(name, 'formaction', 'no browser form navigation');
      if (name === 'href') assert.ok(/^#\/[A-Za-z0-9/_-]*$/.test(value) || isThreadLink(value), `unsafe href ${value}`);
      if (name === 'src') assert.equal(value, 'assets/mark.svg');
    }
  }
}
