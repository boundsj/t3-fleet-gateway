import { X509Certificate } from 'node:crypto';
import * as tls from 'node:tls';

// Temporary eMudhra intermediate-key compromise mitigation (Mozilla bug 2083449).
// Remove after the minimum supported Node release ships nodejs/node#66871 and the
// optional TLS check passes. Root removal also distrusts legitimate sibling chains,
// especially under AAA; see docs/security.md. Match certificate DER, never names.
const distrusted = new Set([
  '86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B', // emSign ECC Root CA - G3
  'D7A7A0FB5D7E2731D771E9484EBCDEF71D5F0C3E0A2948782BC83EE0EA699EF4', // AAA Certificate Services
  '7DD78D5F4F13459A83DFF9ABBBA62EDBAF6F2D102BF257FD712F4D9F2746ED8D', // emSign Root TLS CA - G3 (direct trust)
]);

if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') {
  throw new Error('TLS trust mitigation requires Node.js 24.5.0 or newer.');
}

// The effective defaults include --use-system-ca and NODE_EXTRA_CA_CERTS. Starting
// from rootCertificates instead would silently discard private/extra CAs. Install
// before any connection/session exists: this covers https, tls and fetch/undici
// when they use default trust. Explicit per-connection CA lists override defaults.
tls.setDefaultCACertificates(tls.getCACertificates('default').filter((pem) =>
  !distrusted.has(new X509Certificate(pem).fingerprint256.replaceAll(':', ''))));
