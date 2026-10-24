# Release 0.34.0

Audit the current project for Pi 1.4+ support, merge PR #107, and publish the next minor version, 0.34.0. Pi 1.4.0 is the latest published SDK at the release audit; all three Pi peers require at least 1.4, development pins use 1.4.0, and Node requires at least 22.19.

Include the revised fixes for #104, #97, #92, #91 and #94 with each contributor credited on GitHub and in release notes. Keep one normal Linux validation job. Native Windows checks have already run for this PR and must not return to ongoing CI.

Retain historical release/specification records and saved-goal migration support. Preserve README scope and automated ranking updates. Do not touch the unrelated untracked user directory.

Release success requires a green reviewed head, merged contributor history, a matching stable tag, successful trusted npm publication, verified registry/latest metadata, the GitHub release, and a working extracted package with Pi 1.4.
