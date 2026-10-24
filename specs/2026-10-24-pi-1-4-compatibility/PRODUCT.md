# Current Pi host support

On 2026-10-24 the user asked to update the existing branch and PR #105 so all
code reflects the latest Pi version. npm and the official release list identify
Pi 1.4.0 as the current release for pi-ai, pi-coding-agent and pi-tui.

Develop, build and run the full suite against those exact versions. Audit the
extension's event, prompt/tool, child-session, UI and provider boundaries against
the current public SDK. Use the host's native prompt preparation where available;
retain the request-only repair for older affected hosts. Preserve the approved
immediate default, explicit idle-pacing setting and human lifecycle controls.

Keep the declared older-host support where its tests pass. The extension's Node
floor can remain 22.15 for older compatible hosts; Pi 1.4 itself requires 22.19.
Do not change a user's global CLI installation, real goals or settings. CLI smoke
checks must run the repository's pinned SDK and report its actual version.

Update active documentation, development tools, dependency overrides, lockfile
and CI. Keep historical validation records accurate about the versions actually
used. New evidence must name the installed SDK rather than hard-code an older
version. The README retains its existing scope. Push to the existing branch and
update the concise PR description; no release or merge is requested.

Acceptance: exact consistent 1.4.0 development packages, clean install/typecheck/
lint/full tests, standard-user CLI and SDK lifecycle checks, provider/context
checks with explained host-driven changes, retained older-host coverage, and a
reviewable PR with current results. Native custom runs must preserve additional
extension prompt sections and tool declarations through the first tool follow-up.
Cancellation during startup, including before an assistant response exists, must
leave the associated goal paused without a continuation or provider retry.
Auditor and Oracle settings must accept Pi's `max` thinking level as an explicit
choice, alongside the existing levels; model-specific support remains Pi's job.

Sources checked on 2026-10-24:

- [Pi 1.4.0 release](https://github.com/earendil-works/pi/releases/tag/v1.4.0)
- [Pi 1.2.0 custom-turn preparation changes](https://github.com/earendil-works/pi/releases/tag/v1.2.0)
- Published 1.4.0 package metadata and bundled SDK types/docs/changelog.
