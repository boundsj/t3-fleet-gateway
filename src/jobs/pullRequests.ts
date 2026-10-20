import * as z from 'zod';

/** A small cache of T3-linked PRs, never branch detection or a separate GitHub credential. */
export const MAX_PULL_REQUESTS = 20;
export const pullRequestSchema = z.object({
  host: z.string().min(1).max(253).regex(/^[a-zA-Z0-9.-]+$/),
  repository: z.string().min(1).max(300).regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  url: z.string().max(1000),
  state: z.enum(['open', 'closed', 'merged']).nullable(),
}).refine((pr) => {
  try {
    const url = new URL(pr.url);
    return url.protocol === 'https:' && url.hostname === pr.host && !url.port && !url.username && !url.password &&
      !url.search && !url.hash && url.pathname === `/${pr.repository}/pull/${pr.number}`;
  } catch { return false; }
});
export type PullRequest = z.infer<typeof pullRequestSchema>;
export const pullRequestsSchema = z.array(pullRequestSchema).max(MAX_PULL_REQUESTS).refine(
  (prs) => new Set(prs.map(prKey)).size === prs.length,
);
export const pullRequestListSchema = z.object({ pullRequests: pullRequestsSchema });
export const prKey = (pr: PullRequest): string => `${pr.host}/${pr.repository}#${pr.number}`;

/** Bad stored or downstream data is unknown, never a successful empty result. */
export function readPullRequests(value: unknown): PullRequest[] | null {
  const parsed = pullRequestsSchema.safeParse(value);
  return parsed.success ? parsed.data.sort((a, b) => prKey(a).localeCompare(prKey(b))) : null;
}

/** Initial baselines are silent. Disappearance and unknown states never imply a merge. */
export function pullRequestEvents(previous: PullRequest[] | null, current: PullRequest[]) {
  if (previous === null) return [];
  const old = new Map(previous.map((pr) => [prKey(pr), pr.state]));
  const events: { type: string; detail: { reason: string } }[] = [];
  // One logical event per kind per observation, whose payload contains the complete bounded snapshot.
  for (const state of ['open', 'merged'] as const) {
    if (current.some((pr) => pr.state === state && (!old.has(prKey(pr)) || old.get(prKey(pr)) !== state))) {
      events.push({ type: state === 'open' ? 'pull_request_opened' : 'pull_request_merged', detail: { reason: 'pull_requests_changed' } });
    }
  }
  return events;
}
