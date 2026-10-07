# AGENTS.md

Guidance for coding agents working in this repository. The specification is [docs/design.md](docs/design.md); read the section you are changing first.

## Commands (verified)

```sh
npm install          # dependencies (runtime: @modelcontextprotocol/server, @modelcontextprotocol/client, zod)
npm run check        # tsc --noEmit + all tests; must pass before every commit
npm test             # node --test over test/**/*.test.ts (30 s per-test timeout)
npm run typecheck    # tsc --noEmit
node --test test/oauth-token.test.ts   # one file
node bin/t3-fleet-gateway.js --help    # CLI
```

No build step: Node 24+ runs `.ts` directly. There is no linter or formatter configured; match the surrounding style (2 spaces, single quotes, semicolons, ~140-column lines).

## Entrypoints

| Path | Role |
| --- | --- |
| `bin/t3-fleet-gateway.js` | Launcher; imports `src/cli.ts` |
| `src/cli/main.ts` | `runCli(argv, io)`: every command; returns the exit code |
| `src/gateway.ts` | `openServices` (shared by CLI and server), `startGateway`, `gatewayTools` (the tool list) |
| `src/oauth/` | Authorization server: `routes.ts` (HTTP), `tokens.ts` (codes, rotation, replay), `clients.ts`, `approvalCodes.ts`, `approvalPage.ts` |
| `src/mcp/` | `endpoint.ts` (bearer gate, Origin check, era routing), `tools.ts` (registry and scope checks), `fleetStatus.ts` |
| `src/t3/` | Downstream T3: `client.ts` (MCP client), `results.ts` (result and failure parsing), `pairing.ts` (pairing-code enrollment) |
| `src/hosts/` | `registry.ts` (clients, health cache, enroll and renew), `credentials.ts`, `renewal.ts`, `projects.ts` |
| `src/db/migrations.ts` | Schema, including `jobs`, `job_events`, `idempotency_keys` for the job layer |
| `test/helpers/` | `fakeT3.ts` (fake T3 with OAuth and failure injection), `gateway.ts` (full gateway harness), `oauthFlow.ts`, `agent.ts` (SDK OAuth provider) |

## Adding a tool

Define it with `defineTool` (see `src/mcp/fleetStatus.ts`): name, LLM-oriented description, `scope`, zod input and output schemas, and `run` returning `{ structured, summary }`. Add it to `gatewayTools` in `src/gateway.ts`. Throw `GatewayError` for failures; the registry turns it into an `isError` result with the code. Scope enforcement is automatic.

## Invariants

- Never log or return tokens, approval or pairing codes, authorization headers, task text or worker message content. `test/logging.test.ts` checks this; extend it when adding flows.
- Agent tokens and codes are stored only as hashes; T3 credentials only in `host_credentials`, and never leave the gateway.
- A new T3 credential is saved only after `t3_environment_read` succeeds with it.
- State-changing T3 calls must not be retried blindly: `T3Client.callTool` retries transport failures only with `readOnly: true`. A lost launch response is `unknown`, never relaunched.
- Migrations are append-only; `job_events` is append-only (enforced by triggers).
- Error codes in `src/errors.ts` and OAuth error strings are a stable contract.
- Erasable TypeScript only; `.ts` import specifiers; `import type` for types.
- No machine-specific values or secrets in the repo; tests use synthetic data and loopback ports.

## Status

Round A (OAuth, MCP endpoint, `fleet_status`, T3 client, enrollment, CLI) is done. The job layer (`work_*` tools, dispatcher, watcher, reconciliation) is next; its tables exist and `src/jobs/states.ts` defines the states.
