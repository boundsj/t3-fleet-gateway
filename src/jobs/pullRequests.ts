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
  // T3 lists the repository in lower case while its URL keeps GitHub's casing. GitHub reads owner and repository names (and hosts)
  // without regard to case, so the path and host are compared that way. The URL itself is stored and shown as T3 gave it.
  try {
    const url = new URL(pr.url);
    return url.protocol === 'https:' && url.hostname === pr.host.toLowerCase() && !url.port && !url.username && !url.password &&
      !url.search && !url.hash && url.pathname.toLowerCase() === `/${pr.repository}/pull/${pr.number}`.toLowerCase();
  } catch { return false; }
});
export type PullRequest = z.infer<typeof pullRequestSchema>;
/** One PR is one key, whatever the case of its host and repository. */
export const prKey = (pr: PullRequest): string => `${pr.host}/${pr.repository}#${pr.number}`.toLowerCase();
const byKey = (a: PullRequest, b: PullRequest): number => prKey(a).localeCompare(prKey(b));
/** Which PRs a full snapshot keeps: open ones before the rest, then newest (highest number) first. The key settles ties. */
const byRelevance = (a: PullRequest, b: PullRequest): number =>
  Number(b.state === 'open') - Number(a.state === 'open') || b.number - a.number || byKey(a, b);

/** A stored or returned snapshot: valid, unique and bounded. T3's raw answer goes through `readPullRequests` first. */
export const pullRequestsSchema = z.array(pullRequestSchema).max(MAX_PULL_REQUESTS).refine(
  (prs) => new Set(prs.map(prKey)).size === prs.length,
);
/** T3's answer as it comes. Entries are judged one by one in `readPullRequests`, so an odd entry or a long list never fails the call. */
export const pullRequestListSchema = z.looseObject({ pullRequests: z.array(z.unknown()) });

/**
 * The snapshot a T3 list yields, or null when it holds nothing readable: unknown, never a misleading empty list.
 * Each entry is judged on its own (a bad one is skipped, and a repeat of a PR, compared without case, counts once with the first
 * listed staying). More than MAX_PULL_REQUESTS valid PRs keep the open ones first and then the newest, so the cache stays bounded
 * while a long-running coordinator's recent work still shows. The result is ordered by key, whatever order T3 listed them in.
 */
export function readPullRequests(value: unknown): PullRequest[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return [];
  const unique = new Map<string, PullRequest>();
  for (const entry of value) {
    const parsed = pullRequestSchema.safeParse(entry);
    if (parsed.success && !unique.has(prKey(parsed.data))) unique.set(prKey(parsed.data), parsed.data);
  }
  if (unique.size === 0) return null;
  const valid = [...unique.values()];
  return (valid.length > MAX_PULL_REQUESTS ? valid.sort(byRelevance).slice(0, MAX_PULL_REQUESTS) : valid).sort(byKey);
}

/**
 * Initial baselines are silent. Disappearance and unknown states never imply a merge.
 *
 * A snapshot at the bound is a window onto a longer list: a PR leaving it says nothing, and one that merely appears in it may be an
 * old PR coming back because another left, not news. So when the previous snapshot was full, a PR it did not hold counts only if it
 * outranks that snapshot's last entry (anything ranking below it was left out already).
 */
export function pullRequestEvents(previous: PullRequest[] | null, current: PullRequest[]) {
  if (previous === null) return [];
  const old = new Map(previous.map((pr) => [prKey(pr), pr.state]));
  const last = previous.length < MAX_PULL_REQUESTS ? undefined : previous.reduce((a, b) => (byRelevance(a, b) > 0 ? a : b));
  const isNew = (pr: PullRequest) => last === undefined || byRelevance(pr, last) < 0;
  const events: { type: string; detail: { reason: string } }[] = [];
  // One logical event per kind per observation, whose payload contains the complete bounded snapshot.
  for (const state of ['open', 'merged'] as const) {
    if (current.some((pr) => pr.state === state && (old.has(prKey(pr)) ? old.get(prKey(pr)) !== state : isNew(pr)))) {
      events.push({ type: state === 'open' ? 'pull_request_opened' : 'pull_request_merged', detail: { reason: 'pull_requests_changed' } });
    }
  }
  return events;
}
