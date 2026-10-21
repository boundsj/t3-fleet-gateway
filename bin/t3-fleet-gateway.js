#!/usr/bin/env node
// Thin launcher: Node runs the TypeScript sources directly (type stripping, no build step).
import '../src/tlsTrust.ts';
// Evaluate trust policy before loading the CLI and its outbound transports.
await import('../src/cli.ts');
