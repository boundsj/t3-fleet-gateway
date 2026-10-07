import type { Clock } from '../time.ts';
import { APPROVAL_PAGE_TTL } from './authorizationRequest.ts';

interface Approved {
  /** The authorization response; held only until its code expires, then dropped. */
  response: { url: string; code: string; expiresAt: number } | null;
  forgetAt: number;
}

export type RepeatedApproval = { kind: 'resend'; url: string; code: string } | { kind: 'spent' };

/**
 * Authorization requests approved recently, keyed by the approval form's signature, so that submitting the same
 * form again (a double click, or Back and resubmit) shows where to continue instead of failing on the spent approval
 * code. In memory only: after a restart a repeated form is treated like any other. The response URL, which holds the
 * plaintext authorization code, is kept only until that code expires; the fact of the approval for as long as the
 * form itself is valid.
 */
export class ApprovedRequests {
  readonly #clock: Clock;
  readonly #entries = new Map<string, Approved>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  remember(signature: string, response: { url: string; code: string; expiresAt: number }): void {
    const now = this.#prune();
    this.#entries.set(signature, { response, forgetAt: now + APPROVAL_PAGE_TTL });
  }

  /** What to tell a repeated submission of an approved form, or undefined when the form was not approved. */
  lookup(signature: string): RepeatedApproval | undefined {
    this.#prune();
    const entry = this.#entries.get(signature);
    if (!entry) return undefined;
    return entry.response ? { kind: 'resend', url: entry.response.url, code: entry.response.code } : { kind: 'spent' };
  }

  #prune(): number {
    const now = this.#clock();
    for (const [signature, entry] of this.#entries) {
      if (entry.forgetAt <= now) this.#entries.delete(signature);
      else if (entry.response && entry.response.expiresAt <= now) entry.response = null;
    }
    return now;
  }
}
