/** @implements spec/feature/internal-agent-model-policy.md */
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

/** A session-only plugin avoids competing with Lictor's own --settings argument. */
export async function prepareInternalAgentPlugin(): Promise<string> {
  const runner = fileURLToPath(new URL("../../tools/internal-agent-hook.mjs", import.meta.url)).replaceAll("\\", "/");
  if (/["`$%\r\n]/.test(runner)) throw new Error("Unsupported internal Agent hook path");
  const key = createHash("sha256").update(runner).digest("hex").slice(0, 16);
  const dir = join(tmpdir(), "concordia-internal-agent", key);
  await mkdir(join(dir, ".claude-plugin"), { recursive: true });
  await mkdir(join(dir, "hooks"), { recursive: true });
  await writeFile(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "concordia-internal-agent", version: "1.0.0" }), "utf8");
  await writeFile(join(dir, "hooks", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Agent|Task", hooks: [
    { type: "command", command: 'node "' + runner + '"', timeout: 20 },
  ] }] } }), "utf8");
  return dir;
}

export async function withInternalAgentSettings(
  provider: string,
  args: readonly string[] = [],
  prepare: () => string | Promise<string> = prepareInternalAgentPlugin,
): Promise<string[]> {
  if (provider !== "claude") return [...args];
  const dir = await prepare();
  const equals = args.findIndex(arg => arg.startsWith("--plugin-dir="));
  if (equals >= 0) {
    const current = args[equals]!.slice("--plugin-dir=".length);
    return [...args.slice(0, equals), "--plugin-dir", dir, current, ...args.slice(equals + 1)];
  }
  const existing = args.indexOf("--plugin-dir");
  // Add to the existing variadic flag, avoiding repeated-option parser differences.
  if (existing >= 0) return [...args.slice(0, existing + 1), dir, ...args.slice(existing + 1)];
  // Use = so a following positional prompt is not consumed as another plugin path.
  return ['--plugin-dir=' + dir, ...args];
}
