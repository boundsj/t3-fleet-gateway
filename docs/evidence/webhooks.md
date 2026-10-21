# Outbound webhook verification

Issue [#18](https://github.com/boundsj/t3-fleet-gateway/issues/18), unreleased. Product revision: `44d52388afac79f698c7efbfd1e8ed32d1902d34`; base: `f455545c9cc7689e75d7b67576be3ef8711dbf23`. The subsequent evidence commit adds the smoke harness, its command, this record and the infographic; it does not change product code.

## Reproduce

```sh
npm ci
npm run check
npm run webhooks:smoke -- --receipt ./webhooks-smoke-receipt.json
```

The smoke needs a supported Node (24.22.1 or a later 24.x, or 26.12.1 or newer) and OpenSSL. It takes about 90 seconds because it uses the production retry and lease deadlines. It creates a private temporary gateway directory, an ephemeral CA and HTTPS receiver, a fake T3 host, and real `serve` child processes. CLI enrollment, operator token creation and job actions use the public interfaces. It does not read installed gateway configuration, contact a real T3 runtime, or use hosted-client credentials. Cleanup stops owned children and servers and removes temporary data and keys. The optional receipt contains counts and check names, not secrets, URLs, job content or machine paths.

The HTTPS receiver is trusted only by the child processes through their temporary CA. Certificate validation remains enabled; a negative check proves an untrusted receiver is refused before HTTP delivery. Gateway processes are killed with SIGKILL to exercise actual database recovery, not simulated restarts within one process.

## Recorded results

`npm run check`: **439 tests, 81 suites, all passed**, including **39 webhook tests** and TypeScript checking. The focused tests cover configuration, migration from a populated v8 database, atomic capture and rollback, attribution, subscription revisions, bounded retention/overflow, retries, shutdown, TLS and startup failure isolation.

The independent [smoke receipt](webhooks-smoke.json) records **29/29 checks passed in 85.010 seconds**:

| Check | Observed result |
| --- | --- |
| Required action events | `needs_input`, `idle`, `failed`, `cancelled`, `delegated_work_ended` delivered over real HTTPS |
| Logical events and attempts | 9 logical events, 22 HTTPS attempts; one logical event per controlled source transition |
| Retry and deduplication | HTTP 503, lost acknowledgement and retries retained identical IDs and payload bytes; 4 attempts in the controlled retry scenario |
| Crash recovery | 3 gateway process starts, 2 SIGKILL crashes; pending and in-flight deliveries recovered |
| Receiver isolation | Healthy subscription delivered in **971 ms** while another receiver's response was still held |
| Feed fallback | 6 public `work_feed` pages, 28 events; webhook sequences correlated and the saved contiguous cursor remained exclusive |
| Questions and delegation | Public `work_respond` resumed a real pending request in the fake host; delegated completion and a whole turn between observations both notified |
| Payload and privacy | Auth header present; default excerpts absent; opted-in excerpts bounded and flagged; safe diagnostics and logs excluded secrets and worker content |

The gateway's upstream is synthetic in this test. “Real” here describes the gateway processes, public MCP transport, HTTPS delivery, certificates, timers and crashes, not a live T3 worker or hosted Grok routine.

## Review findings and fixes

An independent review of `8284ea8` reproduced three defects, addressed in `44d5238` with ten additional regressions:

- Startup could reconcile subscription settings before discovering an occupied listener. Both listeners are now reserved before reconciliation, with cleanup on failure; tests prove failed MCP/dashboard binding and invalid secrets preserve the serving instance's queued payloads and route revision.
- One held response blocked refill of otherwise free sender slots. Slots now refill independently, with at most one in-flight delivery per subscription. The independent HTTPS probe measured **9,972 ms before** and **971 ms after** for a healthy route while another was held. The focused fairness regressions also failed before the fix and passed after it.
- Opening an owner-only FIFO as the auth file could block before its type check. Nonblocking, no-follow open followed by a regular-file check now refuses it; a child-process regression bounds completion.

## Limits

No production deployment, real T3 worker run, or hosted Grok routine trigger was exercised. Those integrations remain unverified. The existing gateway watcher determines when a T3 change is observed; webhooks remove the subscriber's polling delay, not that upstream observation interval. Operator-origin attribution is `unknown` when T3 cannot prove it. Delivery is at least once and bounded by a one-hour retry window and queue limits, so receivers must deduplicate and retain `work_feed` catch-up.
