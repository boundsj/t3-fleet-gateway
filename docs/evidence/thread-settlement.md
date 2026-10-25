# Thread settlement contract

Static inspection of the installed T3 executable and the corresponding source paths verified the following behavior. This is contract evidence, not a live settlement qualification; all gateway mutation tests use the synthetic T3 server.

- `ThreadToolkit`'s `t3_thread_organize` accepts `threadId` and `action: "settle"` or `"unsettle"`. It returns a dispatch sequence. Its own agent can instead receive `settlesWhenTurnEnds: true`; the gateway uses an external OAuth host credential and does not depend on deferred settlement.
- `threadAccess` gates writes against read-only credentials and the target's runtime/interaction modes. Denials use `capability_denied`, `runtime_mode_escalation_denied` or `interaction_mode_escalation_denied`. The gateway maps these to fixed `t3_unauthorized` guidance without exposing downstream details or changing credentials.
- `Orchestrator`'s `thread.settle` loads runs, runtime requests and user messages. It refuses preparing/starting/running/waiting runs, queued nonautomatic messages, and pending requests other than message-answerable user input. Its public decider refusals are returned as `orchestration_error`; the gateway maps the known lifecycle messages to `job_state_conflict`.
- The command cancels message-answerable pending input and queued runs originating from automatic notifications or delegated completions. It sets `settledOverride: "settled"` and `settledAt`, clears pin/order fields, removes PR watches and schedules provider-session detachment. It preserves `archivedAt`; archived threads are refused. This is separate from archiving and from interrupting a running turn.
- `OrchestratorMcpService` derives `thread.settled` and `thread.settledAt` from the settlement fields. The gateway parses these fields explicitly, preserving compatibility with older reads that omit them.
- `Orchestrator`'s message dispatch clears a non-null settlement override and timestamp before starting another turn. Thus a settled idle gateway job may receive `work_continue`; terminal job rules are unchanged.

Gateway coverage: `test/settle.test.ts` exercises the public MCP path, fresh activity reads, authorization, replay, downstream refusals, lost replies and confirmed feed events. It does not reproduce T3's provider/session cleanup, which remains T3-owned behavior.
