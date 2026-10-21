import { createHash, X509Certificate } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import tls from 'node:tls';

// Temporary eMudhra intermediate-key block (CVE-2026-111943). These eight SPKI
// SHA-256 hashes match Node's native fix, Go and Electron; never remove roots.
// Source: https://github.com/nodejs/node/commit/d9a3f3d150f7959f2d448d9a61aa11f5a75aa2b3
// Also: https://emudhra.we-have-a-problem.com/impacted-intermediates.json
// Remove after the minimum Node release ships #66871 and verification passes
// without this shim. Until then install before any TLS connection: previously
// cached/resumed sessions skip checkServerIdentity. See docs/security.md.
const compromisedKeys = new Set([
  '49dd353dc2b919a3770645117d0e60c16115e7d1bc259eefe734b00ea434fe5f', // EM DV TLS CA - G3C
  '5c0660a2b164910d8ff589c18e14552e9e0ec237dcefe2cb736d41a4811f81a0', // EM EV TLS CA - G3C
  '63ecefee431d49523bc1136c4e72d0206a477086caf606cd5cf025686c109cf8', // EM OV TLS CA - G3C
  '92c063d67e8f14db71d288e11266ffdaf69cbf115f7bab14f3bc2f68d25e0e30', // EM OV CS CA - G3C
  'ebed6475c2c2d80fcb199f3fe8dd6e6b3ce60b77eb15d4e42c3dec0c6f5b5105', // EM DV TLS CA - G3B
  'ec4ffa1ad0ac88081314b7aaffef6a91f97cd57291bb5ba686c5415f5eb4f6b6', // EM OV CS CA - G3B
  '43bffa19d6ef651451f6841e019931e96f6f2eaeff28ab4b6f1ce4576de2717b', // EM OV TLS CA - G3B
  'e0254c7fcdc265e2f0f8a428dabb75ab4ae039b4872d62f5ee57f0877d5a8a41', // EM EV TLS CA - G3B
]);

/** Check keys, not subjects or certificate fingerprints: cross-signs share keys. */
export function checkCompromisedKeys(peer: tls.PeerCertificate): Error | undefined {
  const seen = new Set<tls.PeerCertificate>();
  try {
    for (let cert: tls.PeerCertificate | undefined = peer; cert && !seen.has(cert);
      cert = (cert as tls.DetailedPeerCertificate).issuerCertificate) {
      seen.add(cert);
      const spki = new X509Certificate(cert.raw).publicKey.export({ type: 'spki', format: 'der' });
      if (compromisedKeys.has(createHash('sha256').update(spki).digest('hex'))) {
        return Object.assign(new Error('TLS certificate chain contains a compromised key.'), { code: 'CERT_REVOKED' });
      }
    }
  } catch {
    return Object.assign(new Error('TLS certificate keys could not be checked.'), { code: 'ERR_TLS_CERT_CHAIN_CHECK' });
  }
}

const connect = tls.connect;
const isOptions = (value: unknown): value is tls.ConnectionOptions => value !== null && typeof value === 'object';

// Compose at connection creation so custom hostname checkers also get the block.
// Approach reviewed in @atproto-labs/fetch-node's dependency-free preload:
// https://github.com/bluesky-social/atproto/blob/fc60876949cca1ca28e98273ecfc97a151d3ebfc/packages/internal/fetch-node/src/emudhra-preload.mjs
// Normal chain/hostname validation still runs; rejectUnauthorized:false can bypass
// rejection. Direct TLSSocket users and references saved before installation are
// outside this wrapper. No CA store changes: system/extra/private CAs keep working.
tls.connect = function (this: unknown, ...args: unknown[]): tls.TLSSocket {
  const index = isOptions(args[0]) ? 0 : isOptions(args[1]) ? 1
    : isOptions(args[2]) || typeof args[1] === 'string' ? 2 : 1;
  const options = isOptions(args[index]) ? args[index] as tls.ConnectionOptions : undefined;
  const checkIdentity = options && Object.hasOwn(options, 'checkServerIdentity') ? options.checkServerIdentity : tls.checkServerIdentity;
  // Let Node report invalid callback arguments using its normal contract.
  if (typeof checkIdentity !== 'function') return Reflect.apply(connect, this, args);
  const guarded = {
    ...options,
    checkServerIdentity(this: unknown, hostname: string, peer: tls.PeerCertificate) {
      return checkCompromisedKeys(peer) ?? checkIdentity.call(this, hostname, peer);
    },
  };
  if (options) args[index] = guarded;
  else args.splice(index, 0, guarded);
  return Reflect.apply(connect, this, args);
} as typeof tls.connect;

// Keep ESM named imports (including https/undici connectors) in sync with CJS.
syncBuiltinESMExports();
