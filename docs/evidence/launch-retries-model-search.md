# Upstream launch retry keys and model search

Source inspection uses pingdotgg/t3code commit [`a773dc38ac75177b6cd133d27df00ca0a83f9480`](https://github.com/pingdotgg/t3code/tree/a773dc38ac75177b6cd133d27df00ca0a83f9480). Feature support is detected from each MCP session's complete `tools/list`, not a version string. No live gateway or real worker launch was used to qualify this change.

## Launch and follow-up keys

Upstream [PR #16654](https://github.com/pingdotgg/t3code/pull/16654) adds optional `clientRequestId` to `t3_thread_launch`:

- [Tool input](https://github.com/pingdotgg/t3code/blob/a773dc38ac75177b6cd133d27df00ca0a83f9480/apps/server/src/mcp/toolkits/project/tools.ts#L121-L150).
- [Handler](https://github.com/pingdotgg/t3code/blob/a773dc38ac75177b6cd133d27df00ca0a83f9480/apps/server/src/mcp/toolkits/project/handlers.ts#L62-L137) hashes the pair of invocation namespace and key with SHA-256 to derive the command, thread and initial message ids. A retry reuses these ids and replays an accepted launch.
- [Regression tests](https://github.com/pingdotgg/t3code/blob/a773dc38ac75177b6cd133d27df00ca0a83f9480/apps/server/src/mcp/toolkits/project/handlers.test.ts#L246-L290) check equal ids for the same key and distinct ids for different or omitted keys.
- [Launch receipts](https://github.com/pingdotgg/t3code/blob/a773dc38ac75177b6cd133d27df00ca0a83f9480/apps/server/src/orchestration-v2/ThreadLaunchService.ts) are looked up by command id, supporting replay after process interruption.
- [OAuth invocation scope](https://github.com/pingdotgg/t3code/blob/a773dc38ac75177b6cd133d27df00ca0a83f9480/apps/server/src/auth/McpOAuth.ts#L552-L575) uses the authorized client's session id as the request namespace. This is distinct from the transient MCP HTTP session. Retrying under a different authorization identity is outside the deduplication guarantee.
- [Plain send](https://github.com/pingdotgg/t3code/blob/a773dc38ac75177b6cd133d27df00ca0a83f9480/apps/server/src/mcp/OrchestratorMcpService.ts#L2912-L2945) already derives stable command/message ids from `clientRequestId`. The gateway preserves its existing job/client/request-derived follow-up key.

The gateway passes `t3fg-launch-<jobId>` for every job launch when advertised, including scratch/root/worktree launches and launches with attachments. It retries one transport failure (including a timeout) with identical input and key. If support disappears on reconnect or the credential changes, it refuses to send another launch. Neither a transport failure nor a tool refusal of the retry can erase uncertainty about the first attempt. A remaining ambiguous outcome or a gateway crash still uses marker reconciliation; the engine does not rebuild and resend an unknown launch from possibly changed settings or re-uploaded attachments. Legacy hosts receive no new launch field and keep the previous behavior.

Plain sends durably bind the request to a private SHA-256 digest of the exact connection credential before delivery, with an attempt count in the existing idempotency response field. Replays after gateway restart require that identity to match. The digest is not a credential and never leaves the ledger. A changed identity, or an older uncertain request without identity metadata, fails closed with `t3_response_lost`; inspect the thread before starting new work. A definite first failure releases the claim only when no overlapping/repeated attempt exists. A later refusal cannot discard a previous ambiguous attempt. Completed sends still replay their stored result without contacting T3. No database schema or package version change is needed.

The [attachment follow-up contract](https://github.com/pingdotgg/t3code/blob/a773dc38ac75177b6cd133d27df00ca0a83f9480/apps/server/src/mcp/toolkits/attachment/tools.ts) has no `clientRequestId`. Such sends keep the durable uncertainty marker and never resend after the send boundary. A retry key cannot be safely invented for an API that does not honor it.

## Model search

[PR #22889](https://github.com/pingdotgg/t3code/pull/22889) introduced compact catalogs and search. [PR #26448](https://github.com/pingdotgg/t3code/pull/26448) refines provider-name matching.

- [Input and output contracts](https://github.com/pingdotgg/t3code/blob/a773dc38ac75177b6cd133d27df00ca0a83f9480/packages/contracts/src/orchestratorMcp.ts#L572-L610): optional trimmed, nonempty `search`, at most 200 characters; per-provider `omittedModels` counts unlisted visible models or unlisted search matches.
- [Selection algorithm](https://github.com/pingdotgg/t3code/blob/a773dc38ac75177b6cd133d27df00ca0a83f9480/apps/server/src/mcp/OrchestratorMcpService.ts#L283-L333): case-insensitive words match model ids, names and subproviders; provider-name words are removed. Hidden models are excluded (custom models remain visible). Search matches are capped at eight per provider, with no pagination. Provider-only queries use the short default list, not an exhaustive list.

`fleet_models.search` exposes that search, including omissions, with gateway paging over the returned snapshot. Queries share the existing per-host cache bound: replacing the query replaces its snapshot, and a cursor requires its original query. Explicit `work_start` model validation searches the requested id in a fresh catalog both at acceptance and dispatch; options still must match exactly. Legacy hosts receive `{}` and expose their older catalog.

Upstream search enables discovery beyond the default list but does not provide exhaustive enumeration. Hidden models and a model beyond eight overlapping matches cannot be promised by this interface; narrow the query when omissions are reported. Validation fails closed if the requested exact id is absent. No claim is made that every historical release or provider honors keys/search correctly merely because it advertises the fields; coverage here uses strict synthetic MCP hosts and upstream source/tests.
