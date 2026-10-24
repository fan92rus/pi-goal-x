// Re-export only the TUI runtime used by pi-goal-x tests. Importing the package
// root initializes unrelated media/native modules and dominates cold startup.
export { Editor } from "@earendil-works/pi-tui/dist/components/editor.js";
export { Text } from "@earendil-works/pi-tui/dist/components/text.js";
export { Key, matchesKey, parseKey, isKittyProtocolActive } from "@earendil-works/pi-tui/dist/keys.js";
export { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui/dist/utils.js";

export { Input } from "@earendil-works/pi-tui/dist/components/input.js";
export { getKeybindings } from "@earendil-works/pi-tui/dist/keybindings.js";
