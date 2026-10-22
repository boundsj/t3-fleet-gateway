# T3 thread catalog compatibility

Source baseline: [T3 Code 0.1.2-nightly.20261021.3499](https://github.com/pingdotgg/t3code/releases/tag/v0.1.2-nightly.20261021.3499), commit `b5a226e49c52ecab4ddc2d678a7012d97e651a6a`.

The gateway's original catalog rejected both duplicate ids and any id outside `[A-Za-z0-9_-]{1,256}` with the same `t3_invalid_response` message. `work_adopt` used that same narrow pattern. Refresh could not repair valid ids containing colons or percent escapes.

## Issued id forms

These are application thread ids; `ProviderThreadId`, run ids, command ids and project ids are separate branded types.

| Form | Source at the pinned commit |
| --- | --- |
| Plain UUID | [web `newThreadId`, utils.ts lines 36–46](https://github.com/pingdotgg/t3code/blob/b5a226e49c52ecab4ddc2d678a7012d97e651a6a/apps/web/src/lib/utils.ts#L36-L46) |
| `mcp:<uuid>` | [MCP launch copies its command id, project/handlers.ts lines 57–65](https://github.com/pingdotgg/t3code/blob/b5a226e49c52ecab4ddc2d678a7012d97e651a6a/apps/server/src/mcp/toolkits/project/handlers.ts#L57-L65); [command minting, threadAccess.ts lines 183–185](https://github.com/pingdotgg/t3code/blob/b5a226e49c52ecab4ddc2d678a7012d97e651a6a/apps/server/src/mcp/threadAccess.ts#L183-L185) |
| `thread:mcp:<encoded namespace>:<encoded request key>:<index>` | [batch creation, OrchestratorMcpService.ts lines 759–772](https://github.com/pingdotgg/t3code/blob/b5a226e49c52ecab4ddc2d678a7012d97e651a6a/apps/server/src/mcp/OrchestratorMcpService.ts#L759-L772) |
| `thread:provider:<driver>[:provider-instance:<encoded instance>]:native-thread:<encoded native id>` | [IdAllocator.ts lines 191–213](https://github.com/pingdotgg/t3code/blob/b5a226e49c52ecab4ddc2d678a7012d97e651a6a/packages/provider-core/src/server/IdAllocator.ts#L191-L213) |
| `thread:delegated-task:<encoded command id>` | [IdAllocator.ts lines 259–261](https://github.com/pingdotgg/t3code/blob/b5a226e49c52ecab4ddc2d678a7012d97e651a6a/packages/provider-core/src/server/IdAllocator.ts#L259-L261) |
| `thread[:fixture:<encoded fixture>][:project:<encoded project>]:<uuid>` | [allocator, IdAllocator.ts lines 235–250 and 338–347](https://github.com/pingdotgg/t3code/blob/b5a226e49c52ecab4ddc2d678a7012d97e651a6a/packages/provider-core/src/server/IdAllocator.ts#L338-L347); [default launch uses it, ThreadLaunchService.ts lines 857–862](https://github.com/pingdotgg/t3code/blob/b5a226e49c52ecab4ddc2d678a7012d97e651a6a/apps/server/src/orchestration-v2/ThreadLaunchService.ts#L857-L862) |
| `import:<provider instance>:<provider session>` | [AgentSessionImporter.ts lines 224–228](https://github.com/pingdotgg/t3code/blob/b5a226e49c52ecab4ddc2d678a7012d97e651a6a/apps/server/src/project/AgentSessionImporter.ts#L224-L228) |

The allocator's components use `encodeURIComponent`, which leaves `!~*'()` intact and can produce nested percent escapes. The shared gateway validator accepts that grammar with a 2,048-character bound for thread inputs and catalog/link decisions; raw path separators, whitespace and controls remain invalid there. Response and job-output schemas accept any nonblank control-free id up to 2,048 characters, preserving unfamiliar formats for existing work while leaving their generated links null. The upstream [ThreadId brand only requires a trimmed nonblank string](https://github.com/pingdotgg/t3code/blob/b5a226e49c52ecab4ddc2d678a7012d97e651a6a/packages/contracts/src/baseSchemas.ts#L258-L263), so this is a bounded compatibility policy, not a claim that upstream enforces this charset or length.

T3's [link parser/resolver preserves raw ids and also resolves one decoded form](https://github.com/pingdotgg/t3code/blob/b5a226e49c52ecab4ddc2d678a7012d97e651a6a/packages/shared/src/threadLinks.ts#L14-L39). Gateway-generated links preserve raw colon delimiters, so `mcp:<uuid>` links stay byte-identical and do not depend on decoding an encoded MCP delimiter. Literal percent signs and URI/Markdown punctuation are escaped, preserving any percent escapes inside the id after one decode. Webhook payload `link` uses this same construction: ordinary MCP links are unchanged; ids containing literal percent escapes or escaped punctuation have different link bytes than direct interpolation, and unsupported id formats have `link: null`. The payload `threadId`, persistence and control calls retain the original id.

Read-only inspection of a local `t3_thread_list` response independently confirmed plain UUID, `mcp:`, provider-derived and delegated-task forms, including percent escapes. Only shape classifications were inspected; no live ids, titles, paths or other response content are retained here. Valid prefixed ids directly trigger the original rejection. No duplicate was observed in that sample.

## Offset pagination

T3 [re-sorts each project read by descending `updatedAt` and then id](https://github.com/pingdotgg/t3code/blob/b5a226e49c52ecab4ddc2d678a7012d97e651a6a/apps/server/src/orchestration-v2/ThreadManagementService.ts#L728-L748), then [slices at the caller's numeric offset](https://github.com/pingdotgg/t3code/blob/b5a226e49c52ecab4ddc2d678a7012d97e651a6a/apps/server/src/mcp/OrchestratorMcpService.ts#L2689-L2730). There is no upstream snapshot token. A reorder can therefore repeat an entry across pages with an unchanged total, triggering the same original error. That failure mode is source-confirmed and reproduced synthetically; it is not claimed as an observed local duplicate. Deduplication cannot recover an entry omitted by concurrent reordering or make the upstream scan atomic.

Regression coverage uses synthetic ids and pages in `test/threads.test.ts` and `test/thread-id.test.ts`: current id forms, opaque link round-trips, malformed entries, repeated older/newer and equal-time rows, adoption, gateway launch/watch, unfamiliar response ids through controls and lost-launch reconciliation, raw legacy MCP links, dashboard links, raw page bounds and sanitized text limits. Existing snapshot replacement and authorization checks remain covered.
