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
node scripts/e2e-live.ts               # live check against a running gateway and real T3; never in tests (docs/operations.md)
```

No build step: Node 24+ runs `.ts` directly. There is no linter or formatter configured; match the surrounding style (2 spaces, single quotes, semicolons, ~140-column lines).

## Entrypoints

| Path | Role |
| --- | --- |
| `bin/t3-fleet-gateway.js` | Launcher; imports `src/cli.ts` |
| `src/cli/main.ts` | `runCli(argv, io)`: every command; returns the exit code |
| `src/processErrors.ts` | `guardProcess` (uncaught errors in `serve`: Node 26.0's `setTypeOfService` race is logged and ignored, anything else shuts down and exits 1), `isTypeOfServiceRace` |
| `src/gateway.ts` | `openServices` (shared by CLI and server), `startGateway`, `gatewayTools` (the tool list) |
| `src/oauth/` | Authorization server: `routes.ts` (HTTP), `tokens.ts` (codes, rotation, replay), `clients.ts`, `approvalCodes.ts`, `approvalPage.ts` (approval, return and notice pages), `approvedRequests.ts` (repeated submissions) |
| `src/mcp/` | `endpoint.ts` (bearer gate, Origin check, era routing), `tools.ts` (registry and scope checks), `fleetStatus.ts` |
| `src/t3/` | Downstream T3: `client.ts` (MCP client, thread and pending-request wrappers, `T3TransportError.delivery`), `schemas.ts` (output schemas from T3's published tools), `results.ts` (result and failure parsing), `pairing.ts` (pairing-code enrollment) |
| `src/jobs/` | Job layer: `store.ts` (ledger, guarded transitions, events, idempotency keys), `service.ts` (what the `work_*` tools do), `engine.ts` (dispatcher, watcher, reconciliation, host backoff), `derive.ts` (state from a thread read), `interrupt.ts`, `states.ts` |
| `src/mcp/workTools.ts` | The `work_*` tool definitions and descriptions |
| `src/hosts/` | `registry.ts` (clients, health cache, enroll and renew), `credentials.ts`, `renewal.ts`, `projects.ts` (project resolution and the model check used by `doctor` and at startup) |
| `src/db/migrations.ts` | Schema, including `jobs`, `job_events`, `idempotency_keys` for the job layer |
| `test/helpers/` | `fakeT3.ts` (fake T3: OAuth, an in-memory thread model driven by tests, failure injection, including held answers and launches that start no run; `stop()`/`start()` take the host down and back on the same port, `close()` releases it), `gateway.ts` (full gateway harness), `frontDoor.ts` (holds a test's public URL port in front of the gateway), `serveChild.ts` (runs `serve` in a child process that raises synthetic process errors), `jobs.ts` (gateway + fake T3 + Operate agent; `tick()` drives the engine), `oauthFlow.ts`, `agent.ts` (SDK OAuth provider) |
| `scripts/e2e-live.ts` | Live end-to-end check, run by hand only |

## Adding a tool

Define it with `defineTool` (see `src/mcp/fleetStatus.ts`): name, LLM-oriented description, `scope`, zod input and output schemas, and `run` returning `{ structured, summary }`. Add it to `gatewayTools` in `src/gateway.ts`. Throw `GatewayError` for failures; the registry turns it into an `isError` result with the code. Scope enforcement is automatic.

## Invariants

- Never log or return tokens, approval or pairing codes, authorization headers, task text or worker message content. `test/logging.test.ts` checks this; extend it when adding flows.
- Agent tokens and codes are stored only as hashes; T3 credentials only in `host_credentials`, and never leave the gateway.
- A new T3 credential is saved only after `t3_environment_read` succeeds with it.
- State-changing T3 calls must not be retried blindly: `T3Client.callTool` retries transport failures only with `readOnly: true`. A lost launch response is `unknown`, never relaunched. Use `T3TransportError.delivery` to tell `not_delivered` from `unknown`; resend a send only with the same T3 `clientRequestId`. Interrupt keys are per run (`cancelRequestId(jobId, runId)`): the same key re-delivers an interrupt for the same run, and a new run gets a new key.
- Job state changes go through `JobStore.transition` (guarded by the expected `from` states, event appended in the same transaction). Event details hold gateway-generated reasons and codes only.
- The engine is driven by `tick()` in tests (`jobEngine: { autoStart: false }`); tests move time with the injected clock, never with sleeps, except the agent-path test that runs the engine on a short timer.
- The fake T3 follows T3's published tool schemas (strict inputs). When T3's tools change, update `src/t3/schemas.ts` and the fake together; fixtures stay synthetic.
- Migrations are append-only once released; until the first release (no deployed databases) migration 1 is corrected in place. `job_events` is append-only (enforced by triggers).
- Error codes in `src/errors.ts` and OAuth error strings are a stable contract.
- Erasable TypeScript only; `.ts` import specifiers; `import type` for types.
- No machine-specific values or secrets in the repo; tests use synthetic data and loopback ports.
- Fakes that simulate a host going away reset a connection once its first request arrives, never on accept (`fakeT3.ts`, `frontDoor.ts`). Node 26.0's fetch (undici) sets the socket's type of service while writing the request from the socket's `connect` handler; if the reset is already there, macOS fails that with `setTypeOfService EINVAL`, thrown as an uncaught exception that fails whichever test is running (a few in every thousand resets on accept). Resetting after the request arrives gives clients the same `ECONNRESET` without the race. Production `serve` ignores that error (`src/processErrors.ts`); tests deliberately do not filter it, so a new reset-on-accept shows up.
- Tests never release a port and bind it again (test files run in parallel processes, and another one may take it in between): servers listen on port 0 and keep their socket; a gateway that restarts keeps its URL through `test/helpers/frontDoor.ts`.

## Status

Round A (OAuth, MCP endpoint, `fleet_status`, T3 client, enrollment, CLI), round B (the job layer: `work_*` tools, dispatcher, watcher, reconciliation, live end-to-end script), round C (review fixes), round D (review and live-run fixes: per-run interrupt keys, per-job error isolation, launch-error lookups, `stateChangedAt`, host `defaultModelSelection`) and round E (polish: `launch_not_started` for a found thread without a run, failed post-launch lookups stay `unknown`, unreadable search matches skipped, shutdown no longer waits for the startup model check, a gateway-specific `doctor` public URL check) are done. The job layer's behavior in detail, including the T3 fields it relies on, is in docs/design.md under "Jobs → As built". A live run of `scripts/e2e-live.ts` against a real T3 confirmed launching into a fresh worktree and branch, a finished turn's shape and the exclusive `afterPosition` (a test in `test/jobs-derive.test.ts` uses that item sequence), follow-ups, and links; it also showed that T3 refuses launches without a model when the T3 project has no default. A later run through the public URL confirmed interrupting a running job (T3 thread `interrupted`, job `cancelled`) and that an `invalid_request` refusal leaves no thread. Questions, approvals and failed runs are not yet confirmed against a real T3; the script fails unless a cancel interrupts a running job (it retries once with a fresh job if the first one finished first).
