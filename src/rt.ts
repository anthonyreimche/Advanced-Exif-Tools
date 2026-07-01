// Runtime bridge. JSX in every module compiles (classic transform) to
// `React.createElement(...)`, resolving to the `React` binding re-exported here.
// The app injects its own React as `api.react`; we assign it once in activate()
// before any component renders, so all modules share the one instance (a second
// copy would break hooks). `api` and `ui` are likewise stashed for non-component
// code (engine + apply paths) to reach the scoped API without prop-drilling.

import type { SafelightAPI, UiKit } from "./safelight-api";

// Assigned in activate(). The non-null assertions are safe: nothing here runs
// (no render, no engine call) until activate() has wired them up.
export let React!: typeof import("react");
export let api!: SafelightAPI;
export let ui!: UiKit;

export function initRuntime(a: SafelightAPI): void {
  api = a;
  React = a.react;
  ui = a.ui;
}
