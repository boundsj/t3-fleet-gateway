# Discovery smoke evidence (issue #12)

A bounded, isolated live check of opt-in per-host discovery: `fleet_projects`, `fleet_models`, and `work_start` with a `target` and an explicit `modelSelection`.

## Setup

- Implementation heads checked: `820b8c3` initially and `98f33bb` after the three review fixes, both with the same harness and 28 of 28 checks passing. The review fixes also have synthetic regressions in `test/discovery.test.ts`.
- One fresh, QA-only T3 Code instance with a scratch git repository as its only project. No other T3 instance was used.
- A separate gateway data directory, OAuth clients and host credentials. No other gateway, its settings, credentials or data were accessed.
- Driven through the public OAuth and MCP endpoints only, as a hosted agent would be, using text content as well as structured content.
- The real provider launch used an explicit Codex selection: `instanceId` `codex`, a Codex model id, reasoning effort `high`, passed as `options` and recorded by T3 as its own option form (T3 normalizes record options into an array; the gateway sends the record form, which T3 accepts).
- The result file holds check names, pass/fail and the saved selection only: no tokens, codes, paths, thread text or worker messages. It stays in the private QA directory.

## Results

28 of 28 checks passed on both runs. All three jobs created across the initial probe and successful runs were cancelled. The QA gateway and T3 runtime were stopped, and their temporary data and credentials were removed.

| Area | Check | Result |
| --- | --- | --- |
| Gates | Discovery defaults off; `fleet_models` gate enforced; `work_start` with a target refuses `discovery_disabled` | pass |
| Gates | Browsing enabled, launching not: `fleet_projects` works, `work_start` into an unconfigured project refuses `start_disabled` | pass |
| Catalogs | Scratch project discovered by explicit target; text output carries a usable target | pass |
| Catalogs | The real Codex model and `high` effort advertised; text output lists actionable model choices | pass |
| Catalogs | One host unavailable: the healthy host's catalog is still returned | pass |
| Authorization | Host-restricted reader sees one permitted host; `fleet_models` on the other is `not_found`; a read-only client's `work_start` is `insufficient_scope` | pass |
| Authorization | Gate and scope refusals create no jobs | pass |
| Validation | Invalid selection refused with `invalid_argument`; no job created | pass |
| Launch | Real launch is queued first; the requested model and effort are persisted before the launch | pass |
| Restart | Queued discovered job survives a gateway restart; `work_list` `target` filter finds it | pass |
| Run | Real provider run completes; current-format thread link returned; worker reply readable through MCP text | pass |
| Run | T3's own thread payload holds the exact requested model and `high` reasoning effort | pass |
| Idempotency | Replay after restart (saved OAuth client, same request id) returns the original job; exactly one job created | pass |
| Feed | Job lifecycle exposed in the public feed | pass |
| Cleanup | Owned job cancelled and cleaned up | pass |

## Assumptions and limits

- Single host, single project, single provider: multi-host catalogs, same-named projects across hosts and ambiguous title mappings are covered only by the synthetic two-host tests.
- Not a fleet qualification: no second machine, no long-running or concurrent load.
- No hosted connector (Grok, Notion) drove this run; their text-only reading of catalogs is inferred from the text-content checks, not observed.
- Questions, approvals and failed runs under a discovered launch were not exercised here.
- The harness is private to the QA setup and uses the machine's T3 CLI; it is not part of this repository.
