/**
 * Root vitest setup for the `web` project (vitest.config.ts at the repository root).
 *
 * The root run keeps `isolate: false` and `globals: false`, so jsdom and the DOM are shared by the
 * web test files of one run and Testing Library never registers its automatic cleanup. A file that
 * leaves a rendered tree behind (a Testing Library render, or a `createRoot` container appended to
 * `document.body`) would show it to the next file, for example as a second `<table>`.
 * setupFiles run again before every file; hooks run in stack order, so a file's own unmount runs first.
 */

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  // Plain .ts files under web/src run in the node environment and have no DOM to clear.
  if (typeof document === "undefined") return;
  cleanup();
  document.body.replaceChildren();
});
