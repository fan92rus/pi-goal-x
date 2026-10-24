# Custom goal controls

Users can adapt goal commands, shortcuts and interrupt behaviour inside Pi without editing JSON. Existing defaults stay unchanged. This is a new, independently written change based on `codex/continuation-defaults-and-prompt-profile` (1e7a693); PRs #98, #99 and #25 supply user needs only. Do not fetch or reuse their patches.

## Commands

Every existing command action has an editable list of invocation paths. The first path is the preferred spelling; additional paths are aliases. Paths may include subcommands, for example `/goal edit` for the existing confirmed revision workflow. Empty lists disable invocations. Actions retain their existing confirmation, focus and lifecycle checks. Matching uses complete words and the longest matching path, preserving the remaining arguments exactly. Subcommands appear in argument completion. Reject duplicate routes, reserved Pi command roots and conflicting extension roots. Unknown subcommands on a routing-only root show help rather than going to the model.

`/goal-settings` always opens settings as a recovery entry, even if its action has a different preferred spelling or no configured spelling. It accepts `controls` to open the controls screen directly. Other default spellings disappear when replaced. Command changes are saved immediately and applied by an explicit reload while Pi is idle; explain pending changes and preserve unsaved editor text. Never reload in the middle of work automatically.

## Keys

All public goal shortcuts are editable: pause, audit interruption, auditor toggle, dashboard expansion/collapse, compact scrolling, expanded navigation, goal-dialog selection/navigation/auditor toggle, and optional shortcuts for every command action. Each supports one or more keys or an empty list to disable it. Existing dashboard overrides continue to work and inherit per leaf. Record a key directly or enter Pi key names. Validate names and conflicts before saving; explain Pi bindings that would be shadowed. Text editing and the controls/settings screen itself use Pi's normal UI controls, so remapping a goal-dialog key cannot remove access to the configuration screen. Developer-only debug shortcuts remain diagnostics.

## Pausing

The pause shortcut defaults to Escape. Dialogs own their input; a dashboard collapse or audit interrupt takes priority in its own view. There are three explicit behaviours:

* Together (default): pause the goal and abort the current turn immediately.
* Goal first: pause further goal work and let the current Pi turn finish; stop at its boundary without another model request. Another press stops it immediately.
* Turn first: stop the current turn and hold automatic continuation in this session. The goal stays active. Another press pauses the goal; a new user message or Resume continues work. The hold is visible and cannot be bypassed by timers, recovery or wake events. Reload/resume must not silently replay an interrupted autonomous run.

When the pause shortcut moves away from Pi's interrupt key, the Pi interrupt key stops the turn with the same visible hold, without silently pausing the goal. Explicit `/goal-pause` always pauses and stops work. Programmatic aborts retain existing pause behaviour unless the user explicitly chose a turn-only interruption. Track the goal identity throughout abort settlement, focus changes and delayed callbacks.

## Pi interface

Add a prominent Controls entry to `/goal-settings`, plus direct `/goal-settings controls`. Use a bounded screen with Commands, Keys and Pausing sections; keyboard navigation, instant filtering, clear project/global scope, effective values with their source, persistent selection, a detail editor, inheritance/reset and disabled states. Show a plain-language pause sequence preview. Escape cancels edits without writing. Explain errors inline and keep the user's input for correction. Keep useful controls and help visible at 110×32 and 72×20, and remain width-safe on smaller terminals. No model call is needed for settings.

## Acceptance

Test both unchanged defaults and custom controls through the real Pi CLI: configure a subcommand alias, reload and use it; record and use a custom pause key; exercise each pause order during visible work; change scopes and restore inheritance; reject collisions; cancel an edit without saving; navigate a narrow screen. Verify no accidental goal pause from a settings dialog, no continuation during a turn-only hold, no loss of typed editor text, and no command routing or prompts added to ordinary model context. Keep README layout/scope unchanged; document details in docs and the changelog.

## Review of #106

Review the complete change and exercise every controls operation, including less common disable, default, inherit, reset, error-correction and cancellation paths. Reopening pause order selects the saved choice. Settings recovery remains visibly available when its other invocations are disabled. Existing key lists must reopen and save unchanged, including punctuation. Keep the selected value, its source and navigation discoverable on narrow screens; long lists support paging and jumping to either end. Saving from a shortcut explains the available reload path accurately.

Remapped questionnaire hints must describe the working keys. Letter-based selection controls must not consume answer text; native text-editing keys keep working, including Escape to leave the answer editor. Non-conflicting custom dialog keys remain available while typing.

Reduce Actions jobs and elapsed time without removing supported Pi versions or runtime coverage. Keep an always-completing check on documentation-only changes, cancel superseded runs, avoid redundant installs/tests, and run independent isolated checks concurrently. Performance comparisons run without competing validation work. Publication must retain its tag, registry and ranking safeguards.
