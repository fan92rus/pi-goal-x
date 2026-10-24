# Release log

- Confirmed 0.32.3 is the latest npm and GitHub release, making 0.33.0 the next minor version.
- Both feature PRs had green checks. Merged #105 as f48239e, then retargeted and merged #106 as ab9d813. The combined main tree matches the reviewed #106 source exactly.
- Reviewed all open PR descriptions. Commented on #98 and #99 with #106 and the relevant controls, then closed them. No other open proposal is superseded by command/key/pause customization. No contributor patch was used.
- Updated package.json, both package-lock.json root versions and the dated changelog for 0.33.0 on codex/release-0-33-0.
- Local release checks passed: TypeScript, lint, eleven workflow/publication tests, the historical 105-row performance gate, zero production vulnerabilities and whitespace checks. The packed archive contains 77 files, including the controls UI/docs and recovery command, and excludes specs/tests/dependencies.
- The first extracted-package smoke assertion exposed a macOS temporary-path symlink mismatch in the recovery CLI entry guard: the process exited successfully without printing help. Repeating the check with the canonical extracted path printed the expected help. No runtime change was made for this release check.
- Publication and registry verification remain pending; the tag workflow will rerun the complete release validation on hosted Node 24.
