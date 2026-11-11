/**
 * The oldest supported releases with the November 2026 HTTP/2, TLS, llhttp and undici security fixes.
 * They also retain Node's block of the compromised eMudhra/emSign intermediate keys
 * (CVE-2026-111943, nodejs/node#66871). The gateway relies on Node for these protections.
 * Keep in step with `engines` in package.json, the CI matrix and deploy/launchd/install.sh.
 */
export const MIN_NODE_VERSIONS = ['24.22.3', '26.13.1'] as const;

type Version = [major: number, minor: number, patch: number];

const parse = (version: string): Version | undefined => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
};

const minimums = MIN_NODE_VERSIONS.map((version) => parse(version) as Version);
const newestLine = Math.max(...minimums.map(([major]) => major));

/** Whether `version` (`process.versions.node`, with or without a leading `v`) meets the security minimum. */
export function isSupportedNode(version: string): boolean {
  const current = parse(version);
  if (!current) return false;
  const [major, minor, patch] = current;
  // A major after the newest supported line is accepted; majors between supported lines remain excluded.
  if (major > newestLine) return true;
  const line = minimums.find(([lineMajor]) => lineMajor === major);
  if (!line) return false;
  return minor !== line[1] ? minor > line[1] : patch >= line[2];
}

/** The launcher's refusal text, or undefined when the runtime is supported. */
export function nodeVersionProblem(version: string): string | undefined {
  if (isSupportedNode(version)) return undefined;
  return `Node.js ${version} is not supported: use 24.22.3 or a later 24.x, or 26.13.1 or newer. `
    + 'Older releases lack required security fixes (see docs/security.md).';
}
