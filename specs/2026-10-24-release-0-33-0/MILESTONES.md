# Release log

- Confirmed 0.32.3 is the latest npm and GitHub release, making 0.33.0 the next minor version.
- Both feature PRs had green checks. Merged #105 as f48239e, then retargeted and merged #106 as ab9d813. The combined main tree matches the reviewed #106 source exactly.
- Reviewed all open PR descriptions. Commented on #98 and #99 with #106 and the relevant controls, then closed them. No other open proposal is superseded by command/key/pause customization. No contributor patch was used.
- Updated package.json, both package-lock.json root versions and the dated changelog for 0.33.0 on codex/release-0-33-0.
- Local release checks passed: TypeScript, lint, eleven workflow/publication tests, the historical 105-row performance gate, zero production vulnerabilities and whitespace checks. The packed archive contains 77 files, including the controls UI/docs and recovery command, and excludes specs/tests/dependencies.
- The first extracted-package smoke assertion exposed a macOS temporary-path symlink mismatch in the recovery CLI entry guard: the process exited successfully without printing help. Repeating the check with the canonical extracted path printed the expected help. No runtime change was made for this release check.
- Pushed release metadata as 6ca8906 and the annotated v0.33.0 tag. Main CI run 40088259902 passed all three jobs, including all seven Pi versions and ten actual CLI walkthroughs.
- Publication run 40088262019 passed all 1,186 tests with zero failures/skips, context/provider and performance gates, package smoke checks and trusted npm publication with provenance. Registry metadata took about two minutes to propagate; the existing verification loop handled the delay without republishing.
- Verified npm latest is 0.33.0. The downloaded registry tarball is byte-for-byte identical to the workflow artifact; its SHA-512/SHA-1 match registry metadata and its SHA-256 matches the GitHub release asset. All 74 ordinary packaged files match the tag; the three generated ranking files match the workflow's main update. The extracted recovery CLI prints its help.
- Published GitHub release v0.33.0 with notes linking both #105 and #106 and explaining controls, defaults, idle pacing and the finite run allowance. Saved release receipts and validation results in VALIDATION.json. The unrelated untracked user directory remains untouched.
