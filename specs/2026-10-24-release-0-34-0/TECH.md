# Release procedure

1. Verify the npm latest tags for all three Pi packages and pi-goal-x. Audit current package/lock metadata, installed Pi dependencies, runtime hooks/imports, workflows, docs, tests and experiments for older-host support.
2. Prepare 0.34.0 in package.json and both root lockfile versions. Move the unreleased changes into the dated changelog release section. Clean up the remaining older-host test/comment paths and validate them with the full CI on #107.
3. Pack locally, inspect the exact metadata and included modules, and run the recovery CLI plus a real Pi 1.4 goal workflow from the extracted package with deterministic local provider fixtures.
4. Merge #107 with a merge commit pinned to its green head, preserving all contributor commits. Fast-forward local main, verify the merged tree, and push an annotated v0.34.0 tag.
5. Let publish.yml perform ranking updates, tagged-source validation, trusted npm publication with provenance, registry verification and GitHub release creation. Use existing bounded verification/retry behavior; do not duplicate a published version.
6. Verify npm latest/version/peer requirements, published tarball checksums and provenance, GitHub release asset parity, the tagged runtime sources, generated ranking differences, and the extracted-package smoke test. Add concise release notes crediting all five contributors and save a release receipt.

Follow docs/publishing.md. Keep Windows out of current workflows. Historical specs and changelog entries retain their original version references.
