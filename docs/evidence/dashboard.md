# Operator dashboard verification

The v0.1.8 dashboard is an optional operator surface on a separate loopback listener. It does not share routes with the public MCP listener. Page refreshes read the ledger and in-process observations; only **Run checks** makes fresh read-only network checks. Approvals and job controls stay in T3.

## Automated coverage

`npm run check` runs typechecking and the complete test suite. Dashboard tests cover listener isolation, Host/Origin/fetch-metadata restrictions, Funnel refusal, safe rendering and links, client grant and observation states, host failures, job attention, bounded output and privacy. The synthetic demo exercises the real gateway with fake T3 servers, isolated temporary storage and fictional work.

The independent review found and the implementation corrected:

- Replacement bearer-token commands must preserve access and host restrictions and quote names as literal shell arguments.
- Current token capabilities must be distinct from the original approval ceiling after a narrowed refresh or an expired privileged grant.
- Failed gateway checks must remain visible on Overview, including a public ingress mistakenly routed to the dashboard.
- Host checks need an absolute deadline even when joining another caller's MCP initialization; timing out the dashboard must leave the shared operation intact.

Regression tests reproduce these cases. No real token was minted, rotated or revoked to exercise them.

## Browser checks

The running `mixed` demo was driven in a browser, including **Run checks**, view navigation and light/dark appearances. A phone layout defect found in the first implementation was corrected with reflow rather than clipping.

| View | Before, 375 px | After, 320 / 375 / 728 / 1280 px |
| --- | --- | --- |
| Overview | Fits | Fits |
| Clients | 466 px document width | Fits at each width |
| Hosts | 406 px document width | Fits at each width |
| Jobs | Fits | Fits |
| Checks | Fits | Fits |

The corrected implementation also checked long unbroken labels and all three job filters. Browser viewport emulation verifies layout; it is not a physical-phone test.

## Private-proxy smoke

A separate synthetic fleet was briefly mounted under its own tailnet HTTPS path. From a browser, the page loaded, the same-origin snapshot returned 200, and the manual check POST returned 200 with all 13 checks passing. The proxy's Host/Origin behavior worked with an explicit allowed host. That temporary route and fleet were removed afterward.

This smoke used fake T3 hosts and synthetic credentials. It does not claim a new hosted Grok, Muse or Notion connector qualification.

## README image

[The showcase](../images/dashboard.png) contains real desktop-light and phone-dark screenshots of the working dashboard demo, composed into one image. Hosts, projects and activity are fictional; Grok Bot, Muse and Notion are demo clients. The image is 2080 × 1760 pixels, contains no text/EXIF metadata, and includes a visible sample-data label. It is not a screenshot of a real fleet.

## Operational limits

- The network is the dashboard's access boundary: use a private tailnet proxy, never a public tunnel. Anyone allowed to reach that path can read operator metadata and job titles.
- Client status reports server-side grants and observed exchanges, not whether a hosted routine is running or which credential its app saved.
- Health and check results show their observation times. There are no automatic dashboard alerts, schedules or catalog polling.
- Transport notes describe operator configuration; an unreachable T3 endpoint does not identify which network hop failed.
- The in-process SQLite integrity check is synchronous and has no wall-clock deadline. Network checks have their own bounded deadlines.
