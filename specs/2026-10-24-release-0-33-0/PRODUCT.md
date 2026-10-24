# Release 0.33.0

Publish PRs #105 and #106 together as the next minor release on npm and GitHub. Include Pi 1.4 prompt/profile fixes, opt-in idle pacing, configurable commands and keys, pause order, and the reviewed UI and CI improvements.

Keep the standard workflow unchanged: goals continue immediately, Escape pauses the goal and turn together, and custom behavior is opt-in. Release notes must point users to `/goal-settings controls` and explain that `idleContinuationBackoff: true` slows repeated idle replies while a finite `maxAutonomousRuns` provides a hard stop.

Link #106 from superseded customization PRs and close them. Leave unrelated proposals open. Preserve existing user files and the README scope.
