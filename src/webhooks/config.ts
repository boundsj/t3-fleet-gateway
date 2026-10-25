import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import { join } from 'node:path';
import * as z from 'zod';
import { GatewayError } from '../errors.ts';

export const WEBHOOK_EVENTS = ['needs_input', 'idle', 'failed', 'cancelled', 'delegated_work_ended', 'running', 'pull_request_opened', 'pull_request_merged'] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];
export const DEFAULT_WEBHOOK_EVENTS: WebhookEventType[] = ['needs_input', 'idle', 'failed', 'cancelled', 'delegated_work_ended'];
const BLOCKED_HEADERS = new Set([
  'host', 'connection', 'content-length', 'content-type', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'expect',
  'content-encoding', 'content-range', 'http2-settings', 'accept', 'accept-encoding', 'origin', 'referer', 'user-agent', 'via', 'forwarded', 'keep-alive',
]);

export function authHeaderAllowed(value: string): boolean {
  const name = value.toLowerCase();
  if (BLOCKED_HEADERS.has(name) || /^(proxy-|sec-|x-forwarded-)/.test(name)) return false;
  try { validateHeaderName(value); return true; } catch { return false; }
}

export function destinationAllowed(value: string, allowLoopbackHttp: boolean): boolean {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash && !value.includes('#') &&
      (url.protocol === 'https:' || (allowLoopbackHttp && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)));
  } catch { return false; }
}

const subscriptionSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  enabled: z.boolean().default(false),
  url: z.string().min(1).max(4096),
  auth: z.strictObject({
    header: z.string().min(1).max(128).refine(authHeaderAllowed),
    // A filename within the private data directory, never an arbitrary path or symlink.
    secretFile: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  }),
  projects: z.array(z.string().min(1).max(300)).min(1).max(100).optional(),
  hosts: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/)).min(1).max(100).optional(),
  targets: z.array(z.strictObject({ host: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
    projectId: z.string().min(1).max(300) })).min(1).max(100).optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length).default(DEFAULT_WEBHOOK_EVENTS),
  excerptChars: z.int().min(0).max(500).default(0),
  allowLoopbackHttp: z.boolean().default(false),
}).refine((value) => destinationAllowed(value.url, value.allowLoopbackHttp));

export const webhooksSchema = z.strictObject({
  subscriptions: z.array(subscriptionSchema).max(32).default([]),
}).refine(({ subscriptions }) => new Set(subscriptions.map((s) => s.id)).size === subscriptions.length);
export type WebhooksConfig = z.output<typeof webhooksSchema>;
export type SubscriptionConfig = WebhooksConfig['subscriptions'][number];
/** Private route material. Never returned by diagnostics or logged. */
export interface WebhookRoute { url: string; header: string; value: string }

export function loadRoute(subscription: SubscriptionConfig, dataDir: string): WebhookRoute {
  let fd: number | undefined;
  try {
    if (!destinationAllowed(subscription.url, subscription.allowLoopbackHttp) || !authHeaderAllowed(subscription.auth.header)) throw new Error();
    // Opening a FIFO without a writer would block before fstat can reject it. Regular files ignore O_NONBLOCK.
    fd = openSync(join(dataDir, subscription.auth.secretFile), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 8192 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error();
    const value = readFileSync(fd, 'utf8').replace(/\r?\n$/, '');
    if (!value.trim()) throw new Error();
    validateHeaderValue(subscription.auth.header, value);
    return { url: subscription.url, header: subscription.auth.header.toLowerCase(), value };
  } catch {
    // No filesystem path, header name/value, URL, or raw Node error crosses this boundary.
    throw new GatewayError('config_invalid', 'Webhook authentication or destination is invalid; check the private secret file and configuration.');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
