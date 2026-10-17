import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import type { FakeDocument, FakeNode } from './fakeDom.ts';

/** The browser module's exports, typed here (it is plain JavaScript, served as is). */
export interface DashboardApp {
  render(doc: FakeDocument, root: FakeNode, model: Record<string, unknown>, actions: Record<string, (...args: never[]) => unknown>, now?: number): unknown[];
  parseRoute(hash: string): { view: string; id: string | null };
  safeHref(value: unknown): boolean;
}

export const APP_URL = new URL('../../src/dashboard/assets/app.js', import.meta.url);
export const VIEWS = ['overview', 'clients', 'hosts', 'jobs', 'checks'] as const;

export async function loadApp(): Promise<DashboardApp> {
  return (await import(pathToFileURL(APP_URL.pathname).href)) as DashboardApp;
}

/** Structural checks every rendered tree must pass. */
export function assertSafeTree(root: FakeNode): void {
  for (const node of root.elements()) {
    assert.ok(!['script', 'iframe', 'object', 'embed', 'form', 'style', 'link', 'meta', 'base'].includes(node.tag), `unexpected <${node.tag}>`);
    for (const [name, value] of node.attributes) {
      assert.doesNotMatch(name, /^on/i, `event attribute ${name}`);
      assert.notEqual(name, 'style', 'no inline style (blocked by the CSP anyway)');
      if (name === 'href') assert.match(value, /^(#\/[A-Za-z0-9/_-]*|t3-thread:\/\/v1\/[A-Za-z0-9._:-]{1,200})$/, `unsafe href ${value}`);
      if (name === 'src') assert.equal(value, 'assets/mark.svg');
    }
  }
}

