# Sending images and files

Bots can attach bytes to `work_start` and `work_continue`. Files do not need to exist on a gateway or worker machine beforehand. Each item of the optional `attachments` array is either **inline** (base64 in the tool call, fine for small files) or **staged** (uploaded beforehand over HTTP, for screenshots and anything large). The two kinds can be mixed in one call.

## Staged uploads (recommended for images)

A real screenshot is hundreds of thousands of base64 characters, too much for a tool call. Stage it in three steps instead:

```sh
# 1. MCP: reserve the upload (exact size in bytes).
#    work_attachment_prepare { "mimeType": "image/png", "sizeBytes": 327680, "name": "screenshot.png" }
#    -> { "attachmentId": "att_…", "uploadUrl": "https://gateway.example.ts.net/attachments?token=…", "expiresAt": "…", "claimExpiresAt": "…" }

# 2. HTTP: send the raw bytes once, with the prepared Content-Type.
curl --fail -X POST -H 'Content-Type: image/png' --data-binary @screenshot.png "$UPLOAD_URL"
#    -> 201 { "attachmentId": "att_…", "status": "uploaded", … }

# 3. MCP: name it by id.
#    work_start { "project": "pilot", "task": "Fix the layout in the attached screenshot", "requestId": "…",
#                 "attachments": [{ "attachmentId": "att_…" }] }
```

- `work_attachment_prepare` needs Operate on at least one machine. It takes `mimeType`, `sizeBytes` (exact, 1 byte to 5 MiB) and an optional `name`, with the same rules as inline files below. It returns `attachmentId`, `uploadUrl`, `mimeType`, `sizeBytes`, `name`, `expiresAt` (upload deadline, 10 minutes) and `claimExpiresAt` (use it by then, one hour after prepare).
- `POST /attachments` is on the gateway's public MCP listener, never the dashboard. Its only credential is the single-use token in `uploadUrl`'s query string (no bearer token; the gateway's request log records the bare path). Keep the URL private. Any request that presents a live token spends it; if the upload is refused, prepare again. The body is the raw file: `Content-Type` must be the prepared MIME type (parameters such as `charset` are ignored), the length must equal `sizeBytes` exactly, and image bytes must carry their type's signature. A browser `Origin` must be `publicUrl` or an `allowedOrigins` entry, as for `/mcp`; there is no CORS. Answers: `201` uploaded, `401 invalid_token` (missing, unknown, spent or expired, indistinguishably), `403` origin, `415` Content-Type, `400`/`413` size or signature.
- A staged file belongs to the agent (OAuth client) that prepared it: another agent's id reads exactly like an unknown one. It must be uploaded, unexpired and unused. It is claimed exactly once: by `work_start` in the same transaction that records the job (its bytes then move to the job's private launch ledger, so they survive queueing and restarts), or by `work_continue` at the durable send boundary, just before `t3_thread_send_attachments`. An upload to T3 that fails before that boundary claims nothing, so the same `requestId` retries with the same id. Errors name the position in the list (`attachments[2]`), never the id.
- `{ "attachmentId": "…", "name": "other.png" }` overrides the prepared name; without either, the default name rule below applies.
- While a `work_continue` is uploading a staged file to T3, the file is reserved for that request: another request naming it gets `job_state_conflict` (retry later); the gateway also caps staged bytes held in memory by in-flight follow-ups at 40 MiB (`job_state_conflict`, retry shortly). The upload itself must finish before `expiresAt`; a refused upload always closes its connection. Revoking a client (`clients revoke`) stops its outstanding upload URLs and deletes its unclaimed files.
- Each agent may hold at most 8 unclaimed files and 10 MiB at a time (prepared but not uploaded files count until their upload window closes). Expired rows are deleted every five minutes and on each prepare. Claimed rows keep no bytes.
- Request ids hash a staged item by its `attachmentId` and name override, not by its bytes, so a retry with the same `requestId` and the same ids replays as before, even after the staged row is gone; a different id or override under the same `requestId` is `request_id_conflict`.

## Inline files

Inline items carry their bytes in the tool call:

```json
{
  "attachments": [
    {
      "name": "notes.txt",
      "mimeType": "text/plain",
      "data": "SGVsbG8K"
    }
  ]
}
```

Add that field alongside `project`, `task` and `requestId` for `work_start`, or `jobId`, `message` and `requestId` for `work_continue`. The text instruction is still required. Omitting `attachments` or passing `[]` retains the text-only behavior.

## Limits

- At most **8 files**, each nonempty and at most **5 MiB** decoded; **10 MiB** decoded in total, inline and staged together. A MiB is 1,048,576 bytes.
- `data` is canonical standard padded base64, without whitespace, a data URL prefix or a URL-safe alphabet. Image signatures must match the declared image MIME type; this is a header check, not a full image decoder.
- `mimeType` is exactly one of `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `text/plain`, `text/markdown`, `text/csv`, `application/json`, `application/pdf`, `application/octet-stream`.
- `name` is optional: 1–128 ASCII letters, digits, spaces, dots, underscores or hyphens, starting with a letter or digit. It is a display filename, never a path. Without it the gateway uses `attachment-1.png`, `attachment-2.txt`, etc., with an extension inferred from MIME type (`bin` for octet-stream).
- Extra item fields, unsafe filenames, unsupported MIME types, invalid encoding and excessive attachment bounds return `invalid_argument`. JSON type/required-field errors use the MCP schema-validation error. The HTTP body limit is 15 MiB; requests exceeding it fail before tool handling.

URLs are unsupported: fetching caller URLs could expose internal services and would need DNS, redirect and address checks. Bounded bytes avoid that SSRF risk and let request IDs identify immutable content.

## Delivery and retries

The gateway calls `t3_attachment_prepare_upload` on the job's authorized destination host, then POSTs the exact decoded bytes to that host's signed upload route. Only that configured HTTP origin and the attachment-upload path are allowed; redirects are refused. The upload URL is never returned or logged. The same protocol works for a nearby host and a remote host; there is no local file copy, SSH, shell command or shared filesystem dependency.

For `work_start`, the dispatcher passes the returned attachment metadata with the initial `t3_thread_launch` message. No worker starts before its attachments are supplied. When the session advertises launch retry keys, the launch carries the job-derived key and one transport retry reuses the exact same uploaded metadata; legacy hosts retain marker reconciliation. Queued bytes live in a separate private ledger table, so ordinary job/dashboard reads never load them. Acceptance remains downstream-free for alias-only starts. Payloads are cleared after a launch attempt with a known or uncertain outcome, cancellation or failure; definitely undelivered launches retain their queued payload for retry. SQLite deletion is logical: WAL files, free pages and backups can retain old bytes.

For `work_continue`, the gateway sends text and metadata in one `t3_thread_send_attachments` call. A successful response reports `delivery: "accepted"`: this T3 API returns run status but does not distinguish a new turn from steering or queueing. The gateway does not infer new-turn webhook attribution from it.

Request IDs cover attachment order, effective names, MIME types and SHA-256 content hashes of inline files, and the ids and name overrides of staged ones. The idempotency record stores the resulting hash and small outcome, never the base64. Identical successful retries return the first result; changed attachments under the same ID return `request_id_conflict`. Text-only hashes and T3 retry keys remain unchanged.

**T3 attachment sends have no downstream retry key.** Before sending a follow-up, the gateway durably marks the attempt. A timeout, disconnect, rejection or process interruption after that boundary returns `t3_response_lost`; the same ID stays blocked and never sends a duplicate, including after restart. Read `work_messages` or inspect the thread before deciding whether to submit new work with a new ID. This deliberately favors duplicate prevention over automatic recovery, even when a rejection probably occurred before delivery. Upload failures before that boundary can safely retry with the same ID. A concurrent call while an upload is in progress returns `job_state_conflict` and can be retried later.

## Native T3 support and files

T3's native attachment upload contract supports PNG, JPEG, GIF and WebP images up to 10 MiB each, general files up to 50 MiB each, and a ten-minute signed upload URL. The MCP launch/send APIs accept at most eight attachments. The gateway's smaller limits above apply independently.

Images use T3's native `image` attachment metadata, not text descriptions or paths embedded by the gateway. General files use T3's native `file` metadata. T3 stores both in its attachment store **outside the job repository**, claims them for the destination thread, and its provider adapters expose file paths in the worker's message context. This uses T3's existing file delivery rather than creating an untracked file inside a worktree; there is nothing new to gitignore. T3 expires abandoned pending uploads after about 24 hours; delivered attachments follow T3's retention policy.

The relevant T3 source interfaces are:

- `packages/contracts/src/assets.ts`: `AttachmentCreateUploadUrlInput`, `AttachmentCreateUploadUrlResult`, upload lifetime.
- `packages/contracts/src/chatAttachment.ts`: image/file MIME and size contracts.
- `apps/server/src/mcp/toolkits/project/tools.ts` and `handlers.ts`: pending attachments in the initial launch message.
- `apps/server/src/mcp/toolkits/attachment/tools.ts` and `handlers.ts`: prepare/upload/send contracts, no send retry key.
- `apps/server/src/assets/AttachmentUpload.ts` and `orchestration-v2/AttachmentClaims.ts`: bounded byte storage and thread claims.
- `packages/provider-core/src/server/attachmentPrompt.ts`: native image classification and file-path context.
- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`: native image items added alongside text in the provider turn.

Provider/model attachment support varies: T3 acceptance does not promise that every adapter or selected model can consume every type. An unavailable attachment API fails the job/follow-up; the gateway never silently drops an attachment or sends only its text. There is no shell-based fallback for older T3 builds. Synthetic protocol tests cover delivery and retries; no live provider image interpretation is claimed.

Attachments, filenames, staged attachment ids, upload tokens and URLs, T3 uploaded IDs, signed URLs and content hashes never enter gateway logs, event details, job views, dashboards or webhook payloads. The bot's text instruction and a worker's own output may still refer to a file; existing message access and optional webhook excerpts keep their usual behavior. The private ledger (`job_launch_attachments`, and `staged_attachments` until a staged file is claimed or expires) and the selected T3 host receive the supplied bytes. Attach only content the selected worker may read.
