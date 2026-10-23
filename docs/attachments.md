# Sending images and files

Bots can attach bytes to `work_start` and `work_continue`. Files do not need to exist on a gateway or worker machine beforehand. Both tools accept the same optional `attachments` array:

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

- At most **8 files**, each nonempty and at most **5 MiB** decoded; **10 MiB** decoded in total. A MiB is 1,048,576 bytes.
- `data` is canonical standard padded base64, without whitespace, a data URL prefix or a URL-safe alphabet. Image signatures must match the declared image MIME type; this is a header check, not a full image decoder.
- `mimeType` is exactly one of `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `text/plain`, `text/markdown`, `text/csv`, `application/json`, `application/pdf`, `application/octet-stream`.
- `name` is optional: 1–128 ASCII letters, digits, spaces, dots, underscores or hyphens, starting with a letter or digit. It is a display filename, never a path. Without it the gateway uses `attachment-1.png`, `attachment-2.txt`, etc., with an extension inferred from MIME type (`bin` for octet-stream).
- Extra item fields, unsafe filenames, unsupported MIME types, invalid encoding and excessive attachment bounds return `invalid_argument`. JSON type/required-field errors use the MCP schema-validation error. The HTTP body limit is 15 MiB; requests exceeding it fail before tool handling.

URLs are deliberately unsupported. Fetching arbitrary caller URLs would let an agent reach internal services through the gateway and would require DNS, redirect and address-policy enforcement. Sending bounded bytes avoids that SSRF surface and lets request IDs identify immutable content.

## Delivery and retries

The gateway calls `t3_attachment_prepare_upload` on the job's authorized destination host, then POSTs the exact decoded bytes to that host's signed upload route. Only that configured HTTP origin and the attachment-upload path are allowed; redirects are refused. The upload URL is never returned or logged. The same protocol works for a nearby host and a remote host; there is no local file copy, SSH, shell command or shared filesystem dependency.

For `work_start`, the dispatcher passes the returned attachment metadata with the initial `t3_thread_launch` message. No worker starts before its attachments are supplied. Queued bytes live in a separate private ledger table, so ordinary job/dashboard reads never load them. Acceptance remains downstream-free for alias-only starts. Payloads are cleared after a launch attempt with a known or uncertain outcome, cancellation or failure; definitely undelivered launches retain their queued payload for retry. SQLite deletion is logical: WAL files, free pages and backups can retain old bytes.

For `work_continue`, the gateway sends text and metadata in one `t3_thread_send_attachments` call. A successful response reports `delivery: "accepted"`: this T3 API returns run status but does not distinguish a new turn from steering or queueing. The gateway does not infer new-turn webhook attribution from it.

Request IDs cover attachment order, effective names, MIME types and SHA-256 content hashes. The idempotency record stores the resulting hash and small outcome, never the base64. Identical successful retries return the first result; changed attachments under the same ID return `request_id_conflict`. Text-only hashes and T3 retry keys remain unchanged.

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

Attachments, filenames, uploaded IDs, signed URLs and content hashes never enter gateway logs, event details, job views, dashboards or webhook payloads. The bot's text instruction and a worker's own output may still refer to a file; existing message access and optional webhook excerpts keep their usual behavior. The private ledger and the selected T3 host receive the supplied bytes. Attach only content the selected worker may read.
