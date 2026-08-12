// Prepares a clean clone or Git worktree to build and validate Concordia.
//
// `@ludiars/vestigium` is a file dependency backed by a Git submodule. Root
// installation can invoke its prepare hook, so Vestigium must have its own
// development dependencies and built dist output before the root install runs.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vestigiumDirectory = join(root, "lib", "vestigium");
const packageDirectories = [root, join(root, "web")];
const npmCiArgs = ["ci", "--include=dev"];
const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm";

function runNpm(args, cwd) {
  const displayDirectory = relative(root, cwd) || ".";
  process.stdout.write(`[bootstrap] ${displayDirectory}$ npm ${args.join(" ")}\n`);
  const commandArgs = process.platform === "win32"
    ? ["/d", "/s", "/c", "npm", ...args]
    : args;
  execFileSync(command, commandArgs, { cwd, stdio: "inherit" });
}

function initializeSubmodules() {
  execFileSync("git", ["submodule", "update", "--init", "--recursive"], {
    cwd: root,
    stdio: "inherit",
  });
}

function buildVestigium() {
  if (!existsSync(join(vestigiumDirectory, "package.json"))) {
    throw new Error("Vestigium submodule initialization did not create lib/vestigium/package.json.");
  }
  // Install before prepare so TypeScript is present when the explicit build runs.
  runNpm([...npmCiArgs, "--ignore-scripts"], vestigiumDirectory);
  runNpm(["run", "build"], vestigiumDirectory);
}

function installWorkspacePackages() {
  for (const packageDirectory of packageDirectories) {
    runNpm(npmCiArgs, packageDirectory);
  }
}

try {
  initializeSubmodules();
  buildVestigium();
  installWorkspacePackages();
  process.stdout.write("[bootstrap] Concordia is ready for build, test, and lint.\n");
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[bootstrap] failed: ${detail}\n`);
  process.exitCode = 1;
}
