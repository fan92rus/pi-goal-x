# Release procedure

Merge #105, retarget #106 to main, then merge #106 without rewriting either history. Prepare version 0.33.0 in package.json and both root package-lock.json version fields. Move the unreleased changelog entries into the dated release section.

Use `docs/publishing.md`: merge the release metadata into main, push the matching annotated stable tag, and let the trusted-publishing workflow validate, pack once, publish with provenance, verify registry integrity, and create the GitHub release. Preserve automated ranking updates. Verify the released tarball and latest dist-tag before reporting success.

The feature branches already passed the full suite and actual Pi workflows. Check release metadata, package contents and recovery CLI locally; require the hosted release checks to pass for the tagged source.
