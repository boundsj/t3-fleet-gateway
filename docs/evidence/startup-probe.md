# Startup probe deadline evidence (0.1.7)

Why the configured non-mutating probe's deadline went from two seconds to ten.

## Observed failure

The deployed macOS gateway logged `probe_timeout` for its configured `mintPairingCodeProbe` (a non-mutating T3 version check) on every start, on both the 0.1.6 head and the discovery head. The probe code, the launchd template and the host configuration were unchanged between those builds, and the same command answered in well under a second when run by hand. Foreground doctor passed. The HTTP listener, credentials and jobs remained healthy; the failed startup probe diagnostic prevented a version comparison, while the renewal loop still started after preflight settled.

## Isolated measurement

The operator ran the exact configured probe argv, with the service's environment and working directory, as a one-shot launchd job under each `ProcessType`, with the gateway's deadline applied. The production config and plist were read to reproduce the configured probe and process settings; the diagnostic jobs did not open the gateway credential database or modify or restart the production service. No command output or arguments are recorded here.

| Launch | Deadline | Elapsed | Result |
| --- | --- | --- | --- |
| Foreground shell, full environment | 2 s | 608 ms | pass |
| Foreground shell, minimal service environment | 2 s | 560 ms | pass |
| launchd `ProcessType` Background | 2 s | 2,009 ms | timeout |
| launchd `ProcessType` Background | 10 s | 2,837 ms | pass |
| launchd `ProcessType` Interactive | 2 s | 543 ms | pass |
| launchd `ProcessType` Standard | 2 s | 581 ms | pass |

A Background agent runs its children at a lower CPU and I/O priority, which is enough to push a half-second probe past two seconds on this machine. The environment is not the cause: the minimal service environment passes in the foreground.

## Decision

Raise the probe deadline to ten seconds (`PROBE_TIMEOUT_MS` in `src/hosts/commandPreflight.ts`) and change nothing else. The deadline is a bound on a misbehaving probe, not an expected duration: a probe still answers as fast as it can, startup does not wait on it (the HTTP listener is up before preflight finishes, and renewal starts when the host checks settle), and shutdown aborts it with SIGKILL as before. The cost of the larger bound is that a hung probe can delay the first renewal pass by up to ten seconds instead of two, and `doctor` can take up to ten seconds per host with a hung probe. Output budgets, the exact configured argv, executable resolution and the non-mutating-only rule are unchanged.

The template's `ProcessType` was deliberately left at Background. Running the gateway as Standard or Interactive would also have passed, but it would change the service's priority for everything it does to fix a diagnostic, and the ten-second bound covers the measured delay with margin.

## Not covered

The automated tests check that the injected runner receives the ten-second deadline and keep the short-override, cancellation, SIGTERM-resistant child and late-completion cases; none of them waits several seconds for a real probe. A separate Background launchd job using the patched implementation with its default deadline (no timeout override) passed in 2,956 ms with `probe_succeeded` and `version_matches`. Confirming the production agent does the same remains a deployment check.
