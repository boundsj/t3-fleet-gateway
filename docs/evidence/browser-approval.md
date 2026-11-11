# Browser approval verification

The generic browser approval path was exercised against an isolated gateway with synthetic clients, two synthetic hosts, a temporary ledger and no downstream credentials. No provider command or fleet job was started.

## Automated checks

`npm run check` on supported Node 26.12.1 passed: 956 tests, 931 passed, 25 skipped, zero failures, plus TypeScript and privacy checks. The suite includes enrollment, signed owner approval, callback/PKCE exchange, MCP and refresh; denial, expiry, replay, competing decisions, sign-out and revocation; hostile fields, redirects, origins, hosts and CSRF attempts; scope/machine ceilings; CLI-code and bearer regressions; restart behavior and populated schema 21 to 22 migration preservation.

The follow-up regressions cover sibling handles for identical signed requests (Allow/Allow and Deny/Allow, including a new offer after settlement), reversed request response ordering, stale consent buttons and navigation during an outstanding decision. Displayed consent is bound to its handle, and a response for a page the owner left cannot navigate the new page.

## Real browser check

Chrome 156 ran the actual owner HTML/CSS/module and called the real listeners through local test proxies, with the dashboard mounted at `/fleet` on a distinct origin. A software authenticator supplied the browser credential API's answers; this does **not** qualify platform passkey interoperability.

The following paths passed:

- One-time enrollment through the page, then sign-out.
- Generic client registration and authorization page, dashboard review link, passkey sign-in and explicit Allow. Selecting Read and only `studio` produced a successful callback and PKCE exchange carrying exactly `host:studio:read`.
- A second request reused the signed-in owner session; Deny returned `access_denied` with the client's state.
- Page JavaScript could not read the HttpOnly session cookie.
- Desktop light appearance at 1280 by 800 and phone-width dark appearance at 390 by 844 displayed the full redirect origin and consent choices without horizontal overflow. Keyboard Tab reached the native controls with a visible outline.

The browser fixture used loopback HTTP origins, permitted by WebAuthn for local development. Automated protocol tests also exercise distinct synthetic HTTPS origins and Secure cookie attributes; real HTTPS proxy/cookie delivery and a real hardware or synced passkey remain deployment/device checks. Phone-width desktop Chrome is not a physical phone, and no screen-reader or real touch qualification is claimed. Pending authorizations intentionally expire on restart; persisted passkeys and sessions survive.
