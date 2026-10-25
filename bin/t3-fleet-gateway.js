#!/usr/bin/env node
// Thin launcher: Node runs the TypeScript sources directly (type stripping, no build step).
import { nodeVersionProblem } from '../src/nodeVersion.ts';

// Outbound TLS relies on Node itself to block the compromised eMudhra/emSign intermediates.
const problem = nodeVersionProblem(process.versions.node);
if (problem) {
  process.stderr.write(`t3-fleet-gateway: ${problem}\n`);
  process.exit(1);
}
await import('../src/cli.ts');
