/**
 * The oldest Node release on each supported line that rejects TLS chains containing the eight
 * compromised eMudhra/emSign intermediate keys (CVE-2026-111943, nodejs/node#66871). The gateway
 * relies on Node for that block, so an older runtime would silently trust those chains again.
 * Keep in step with `engines` in package.json, the CI matrix and deploy/launchd/install.sh.
 */
export const MIN_NODE_VERSIONS = ['24.22.1', '26.12.1'] as const;

type Version = [major: number, minor: number, patch: number];

const parse = (version: string): Version | undefined => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
};

const minimums = MIN_NODE_VERSIONS.map((version) => parse(version) as Version);
const newestLine = Math.max(...minimums.map(([major]) => major));

/** Whether `version` (`process.versions.node`, with or without a leading `v`) has the fix. */
export function isSupportedNode(version: string): boolean {
  const current = parse(version);
  if (!current) return false;
  const [major, minor, patch] = current;
  // A major after the newest supported line branched after the fix; a major between lines never got it.
  if (major > newestLine) return true;
  const line = minimums.find(([lineMajor]) => lineMajor === major);
  if (!line) return false;
  return minor !== line[1] ? minor > line[1] : patch >= line[2];
}

/** The launcher's refusal text, or undefined when the runtime is supported. */
export function nodeVersionProblem(version: string): string | undefined {
  if (isSupportedNode(version)) return undefined;
  return `Node.js ${version} is not supported: use 24.22.1 or a later 24.x, or 26.12.1 or newer. `
    + 'Older releases do not block the compromised eMudhra/emSign intermediate certificates (see docs/security.md).';
}
