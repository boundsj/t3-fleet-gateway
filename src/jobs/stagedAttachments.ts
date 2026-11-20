import { randomToken, sha256Hex } from '../crypto.ts';
import { transaction, type Database } from '../db/database.ts';
import { GatewayError } from '../errors.ts';
import { HOUR, MINUTE, type Clock } from '../time.ts';
import {
  ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_TOTAL_ATTACHMENT_BYTES,
  signatureMatches,
  type AttachmentInput,
  type StagedAttachmentRef,
} from './attachments.ts';

/**
 * Staged attachments: an agent prepares a file with work_attachment_prepare (MCP), uploads the raw bytes once with
 * POST /attachments and a single-use token, then names it by id in work_start or work_continue, which claims it once.
 * The table is private: nothing about a row (bytes, names, ids, tokens) is logged or shown anywhere but to its owner.
 */

/** How long the single-use upload token works after prepare. */
export const UPLOAD_WINDOW_MS = 10 * MINUTE;
/** How long an uploaded file waits to be claimed after prepare. */
export const CLAIM_WINDOW_MS = HOUR;
/** Unclaimed (prepared or uploaded, unexpired) files one client may hold at once. */
export const MAX_PENDING_ATTACHMENTS = MAX_ATTACHMENTS;
export const MAX_PENDING_BYTES = MAX_TOTAL_ATTACHMENT_BYTES;
export const UPLOAD_TOKEN_PATTERN = /^t3fgu_[A-Za-z0-9_-]{43}$/;

export interface PrepareInput {
  name?: string | undefined;
  mimeType: string;
  sizeBytes: number;
}

export interface Prepared {
  attachmentId: string;
  /** Returned once; only its hash is stored. */
  token: string;
  name: string | null;
  mimeType: string;
  sizeBytes: number;
  uploadExpiresAt: number;
  expiresAt: number;
}

/** A started upload: the token is spent, and the body must match this. */
export interface UploadSlot {
  attachmentId: string;
  clientId: string;
  mimeType: string;
  sizeBytes: number;
  /** The upload must complete before this; the route stops reading then. */
  uploadExpiresAt: number;
}

/** Only a client that is not revoked may upload; revocation also deletes its unclaimed files (ClientStore.revoke). */
const ACTIVE_OWNER = 'EXISTS (SELECT 1 FROM oauth_clients WHERE oauth_clients.id = staged_attachments.client_id AND oauth_clients.revoked_at IS NULL)';

/** Which request a staged file was claimed for. */
export interface StagedClaim {
  clientId: string;
  ids: readonly string[];
  jobId: string;
  tool: 'work_start' | 'work_continue';
  requestId: string;
}

interface Row {
  id: string;
  client_id: string;
  name: string | null;
  mime_type: string;
  size_bytes: number;
  data: Uint8Array | null;
  upload_expires_at: number;
  expires_at: number;
  uploaded_at: number | null;
  claimed_at: number | null;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;

export class StagedAttachments {
  readonly #db: Database;
  readonly #clock: Clock;

  constructor(db: Database, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  /** Reserve a slot for one file. Enforces the same rules as inline attachments, plus the per-client pending cap. */
  prepare(clientId: string, input: PrepareInput): Prepared {
    if (input.name !== undefined && (input.name.length < 1 || input.name.length > 128 || !NAME.test(input.name))) {
      throw new GatewayError('invalid_argument', 'name must be 1–128 ASCII letters, digits, spaces, dots, underscores or hyphens, starting with a letter or digit.');
    }
    if (!(ATTACHMENT_MIME_TYPES as readonly string[]).includes(input.mimeType)) {
      throw new GatewayError('invalid_argument', `mimeType must be one of ${ATTACHMENT_MIME_TYPES.join(', ')}.`);
    }
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > MAX_ATTACHMENT_BYTES) {
      throw new GatewayError('invalid_argument', 'sizeBytes must be the exact file size, from 1 byte to 5 MiB (5,242,880 bytes).');
    }
    return transaction(this.#db, () => {
      const now = this.#clock();
      this.#sweep(now);
      const pending = this.#db.prepare(`SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes FROM staged_attachments
        WHERE client_id = ? AND claimed_at IS NULL
          AND ((uploaded_at IS NULL AND upload_expires_at > ?) OR (uploaded_at IS NOT NULL AND expires_at > ?))`)
        .get(clientId, now, now) as { files: number; bytes: number };
      if (pending.files + 1 > MAX_PENDING_ATTACHMENTS || pending.bytes + input.sizeBytes > MAX_PENDING_BYTES) {
        throw new GatewayError('invalid_argument',
          'Too many unclaimed staged attachments: at most 8 files and 10 MiB per agent. Use the ones already uploaded in work_start or work_continue, or wait for them to expire.');
      }
      const attachmentId = `att_${randomToken(18)}`;
      const token = `t3fgu_${randomToken(32)}`;
      const prepared: Prepared = {
        attachmentId, token, name: input.name ?? null, mimeType: input.mimeType, sizeBytes: input.sizeBytes,
        uploadExpiresAt: now + UPLOAD_WINDOW_MS, expiresAt: now + CLAIM_WINDOW_MS,
      };
      this.#db.prepare(`INSERT INTO staged_attachments (id, client_id, token_hash, name, mime_type, size_bytes, created_at, upload_expires_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(attachmentId, clientId, sha256Hex(token), prepared.name, prepared.mimeType, prepared.sizeBytes, now, prepared.uploadExpiresAt, prepared.expiresAt);
      return prepared;
    });
  }

  /**
   * Spend an upload token: any request that presents a live token uses it up, whatever happens next. Returns undefined
   * for a malformed, unknown, spent or expired token, without telling them apart.
   */
  beginUpload(token: string): UploadSlot | undefined {
    if (!UPLOAD_TOKEN_PATTERN.test(token)) return undefined;
    const now = this.#clock();
    const row = this.#db.prepare(`UPDATE staged_attachments SET token_hash = NULL, upload_started_at = ?
      WHERE token_hash = ? AND uploaded_at IS NULL AND upload_started_at IS NULL AND upload_expires_at > ? AND ${ACTIVE_OWNER}
      RETURNING id, client_id, mime_type, size_bytes, upload_expires_at`)
      .get(now, sha256Hex(token), now) as { id: string; client_id: string; mime_type: string; size_bytes: number; upload_expires_at: number } | undefined;
    return row && { attachmentId: row.id, clientId: row.client_id, mimeType: row.mime_type, sizeBytes: row.size_bytes, uploadExpiresAt: row.upload_expires_at };
  }

  /** Store an upload's bytes after the route checked them against the slot: only before the deadline, for an active owner. */
  completeUpload(slot: UploadSlot, bytes: Buffer): boolean {
    if (bytes.length !== slot.sizeBytes || !signatureMatches(slot.mimeType, bytes)) return false;
    const now = this.#clock();
    return this.#db.prepare(`UPDATE staged_attachments SET data = ?, uploaded_at = ?
      WHERE id = ? AND client_id = ? AND uploaded_at IS NULL AND claimed_at IS NULL AND upload_expires_at > ? AND ${ACTIVE_OWNER}`)
      .run(bytes, now, slot.attachmentId, slot.clientId, now).changes === 1;
  }

  /** Milliseconds left before the slot's upload deadline, by the store's clock. */
  remainingMs(slot: UploadSlot): number {
    return Math.max(0, slot.uploadExpiresAt - this.#clock());
  }

  /** A failed upload frees its slot (and the pending cap) at once; the agent prepares again. */
  abandonUpload(slot: UploadSlot): void {
    this.#db.prepare('DELETE FROM staged_attachments WHERE id = ? AND client_id = ? AND uploaded_at IS NULL').run(slot.attachmentId, slot.clientId);
  }

  /**
   * The bytes of the caller's own uploaded, unexpired, unclaimed files, as inline attachments in the given order. Another
   * client's id reads exactly like an unknown one. Errors name the position in the list, never the id.
   */
  resolve(clientId: string, refs: readonly { index: number; ref: StagedAttachmentRef }[]): Map<number, AttachmentInput> {
    const now = this.#clock();
    const resolved = new Map<number, AttachmentInput>();
    const seen = new Set<string>();
    for (const { index, ref } of refs) {
      const where = `attachments[${index}]`;
      if (seen.has(ref.attachmentId)) throw new GatewayError('invalid_argument', `${where} repeats a staged attachment; each one can be used once.`);
      seen.add(ref.attachmentId);
      const row = this.#db.prepare(`SELECT id, client_id, name, mime_type, size_bytes, data, upload_expires_at, expires_at, uploaded_at, claimed_at
        FROM staged_attachments WHERE id = ? AND client_id = ?`).get(ref.attachmentId, clientId) as Row | undefined;
      if (!row) throw new GatewayError('invalid_argument', `${where}: unknown attachmentId. Prepare files with work_attachment_prepare and upload them first.`);
      if (row.claimed_at !== null) throw new GatewayError('invalid_argument', `${where} was already used by another request. Each staged attachment can be used once; prepare it again.`);
      if (row.uploaded_at === null) {
        throw new GatewayError('invalid_argument', row.upload_expires_at > now
          ? `${where} has not been uploaded yet. POST its bytes to the uploadUrl first.`
          : `${where} expired before it was uploaded. Prepare it again.`);
      }
      if (row.expires_at <= now || row.data === null) throw new GatewayError('invalid_argument', `${where} expired. Prepare and upload it again.`);
      const name = ref.name ?? row.name ?? undefined;
      resolved.set(index, { ...(name === undefined ? {} : { name }), mimeType: row.mime_type, data: Buffer.from(row.data).toString('base64') });
    }
    return resolved;
  }

  /** The stored sizes of the caller's own staged files that exist (unknown ids are left out), without loading bytes. */
  sizes(clientId: string, ids: readonly string[]): number {
    const get = this.#db.prepare('SELECT size_bytes FROM staged_attachments WHERE id = ? AND client_id = ? AND data IS NOT NULL');
    return ids.reduce((total, id) => total + ((get.get(id, clientId) as { size_bytes: number } | undefined)?.size_bytes ?? 0), 0);
  }

  /** Delete prepared files whose upload window closed and every file past its claim window. Returns the rows removed. */
  sweep(): number {
    return transaction(this.#db, () => this.#sweep(this.#clock()));
  }

  #sweep(now: number): number {
    return Number(this.#db.prepare(`DELETE FROM staged_attachments
      WHERE (uploaded_at IS NULL AND upload_expires_at <= ?) OR expires_at <= ?`).run(now, now).changes);
  }
}

/**
 * Claim staged files for one request, inside the caller's transaction (the job insert for work_start, the durable send
 * boundary for work_continue). Every id must still be the client's, uploaded, unexpired and unclaimed, or nothing is
 * claimed and the transaction rolls back. The bytes are dropped from the row: they now live in the job's ledger or in T3.
 */
export function claimStaged(db: Database, claim: StagedClaim, now: number): void {
  const update = db.prepare(`UPDATE staged_attachments SET claimed_at = ?, claimed_job_id = ?, claimed_tool = ?, claimed_request_id = ?, data = NULL
    WHERE id = ? AND client_id = ? AND uploaded_at IS NOT NULL AND claimed_at IS NULL AND expires_at > ?`);
  for (const id of claim.ids) {
    if (update.run(now, claim.jobId, claim.tool, claim.requestId, id, claim.clientId, now).changes !== 1) {
      throw new GatewayError('invalid_argument', 'A staged attachment was used by another request or expired meanwhile. Nothing was sent; prepare it again.');
    }
  }
}
