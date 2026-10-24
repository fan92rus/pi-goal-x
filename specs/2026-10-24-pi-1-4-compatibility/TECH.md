# Implementation and verification

1. Pin all three development SDK packages to 1.4.0 and regenerate the lockfile.
   Update the existing security overrides to avoid downgrading the current host's
   undici/brace-expansion versions. Do not change the legacy peer range or Node
   floor without a demonstrated incompatibility.
2. Audit public SDK changes since 1.0, including the discriminated user/custom
   `before_agent_start` event, busy/abort behavior during startup, transcript tool
   changes, resumed tools, UI dialog completion and child-session configuration.
   Honor the current `agent_settled.aborted` flag as well as older signal-based
   abort detection; do not pause a replacement goal or retry a cancelled run.
   Share Pi's seven thinking choices across settings, auditor parsing and the
   selector, including `max`; validate persistence and the actual settings menu.
3. Detect native custom-turn preparation through the public event protocol,
   rather than a version string. Avoid projecting structured transcripts when
   the host already prepares custom runs. Keep the fallback on affected hosts
   and verify both routes, external instructions and tool/result pairing.
4. Make lifecycle/terminal tools select the installed repository CLI and report
   its version. Remove stale version labels from reusable measurements. Keep
   the standalone mismatch probe useful on both repaired and affected hosts,
   without overwriting historical results under the wrong version label.
5. Keep latest Pi in the main full-suite CI job and preserve explicit Pi 1.0
   fallback coverage plus the existing older-host boundaries. Exercise the
   latest host at its own minimum Node version as well.
6. Run clean install, typecheck, lint, full tests, SDK/CLI user flows, context and
   provider checks, retention, packaging and same-machine runtime checks. Inspect
   any context drift against an unmodified main copy on the same new SDK before
   changing a baseline; distinguish SDK guidance from extension overhead.
7. Save concise evidence and failed attempts in this spec, update active docs/
   changelog and PR #105, and push the existing branch. Preserve the earlier
   spec's 1.0 validation as historical evidence.
