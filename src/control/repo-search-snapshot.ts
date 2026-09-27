// @spec CC-REPO-SEARCH-01
import { opendir, readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { SEARCH_BINARY_NAMES, type RepositorySearchSnapshot } from "./repo-search-policy.js";

const EXCLUDED = new Set([".git", ".claude", ".codex", ".vscode", "node_modules", "dist", "build", "out", "target", ".next", ".venv", "venv", "coverage", ".cache", "library", "temp", "obj", "bin", "generated", "logs", "userSettings".toLowerCase()]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".cs", ".go", ".java"]);
const MAX_DIRS = 48;
const MAX_ENTRIES = 500;
const MAX_DEPTH = 3;
const MAX_PATH_DIRS = 16;
const MAX_CONFIG_BYTES = 16_384;

async function exists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function inspectSourceNames(root: string): Promise<{ rootFiles: string[]; extensions: Record<string, number>; sampleLimited: boolean; sampleReasons: string[] }> {
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  const rootFiles: string[] = [];
  const extensions: Record<string, number> = {};
  let dirs = 0;
  let entries = 0;
  const sampleReasons = new Set<string>();
  while (queue.length && dirs < MAX_DIRS && entries < MAX_ENTRIES) {
    const current = queue.shift()!;
    let directory;
    try { directory = await opendir(current.path); }
    catch { sampleReasons.add("directory-read-error"); continue; }
    dirs++;
    for await (const child of directory) {
      if (++entries > MAX_ENTRIES) { sampleReasons.add("entry-limit"); break; }
      if (current.depth === 0 && child.isFile()) {
        if (rootFiles.length < 100) rootFiles.push(child.name);
        else sampleReasons.add("root-file-limit");
      }
      if (child.isFile()) {
        const ext = extname(child.name).toLowerCase();
        if (SOURCE_EXTENSIONS.has(ext)) extensions[ext] = (extensions[ext] ?? 0) + 1;
      } else if (child.isDirectory() && !EXCLUDED.has(child.name.toLowerCase())) {
        if (current.depth < MAX_DEPTH) queue.push({ path: join(current.path, child.name), depth: current.depth + 1 });
        else sampleReasons.add("depth-limit");
      }
    }
  }
  if (queue.length > 0) sampleReasons.add("directory-limit");
  return { rootFiles, extensions, sampleLimited: sampleReasons.size > 0, sampleReasons: [...sampleReasons].sort() };
}

async function configuredServers(root: string, provider: string): Promise<string[]> {
  const paths = provider.includes("claude") ? [".claude/settings.json", ".mcp.json"] : [];
  const found = new Set<string>();
  for (const path of paths) {
    const target = join(root, path);
    let size: number;
    try { size = (await stat(target)).size; } catch { continue; }
    if (size > MAX_CONFIG_BYTES) continue;
    try {
      const config = JSON.parse(await readFile(target, "utf8")) as unknown;
      if (!config || typeof config !== "object") continue;
      const fields = config as Record<string, unknown>;
      const plugins = fields["enabledPlugins"];
      if (plugins && typeof plugins === "object" && !Array.isArray(plugins)) {
        for (const [plugin, enabled] of Object.entries(plugins)) {
          if (enabled !== true) continue;
          for (const name of SEARCH_BINARY_NAMES) if (plugin.toLowerCase().startsWith(name.toLowerCase())) found.add(name);
        }
      }
      const servers = fields["mcpServers"];
      if (servers && typeof servers === "object" && !Array.isArray(servers)) {
        for (const entry of Object.values(servers)) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
          const server = entry as Record<string, unknown>;
          if (server["disabled"] === true || server["enabled"] === false) continue;
          const command = typeof server["command"] === "string" ? server["command"].toLowerCase() : "";
          for (const name of SEARCH_BINARY_NAMES) if (command.endsWith(name.toLowerCase()) || command.endsWith(name.toLowerCase() + ".exe")) found.add(name);
        }
      }
    } catch { /* An unreadable config does not establish absence. */ }
  }
  return [...found];
}

async function inspectBinaries(root: string): Promise<{ binaries: Record<string, boolean>; pathLimited: boolean }> {
  const envPaths = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  const dirs = [join(root, "node_modules", ".bin"), join(root, ".venv", process.platform === "win32" ? "Scripts" : "bin"),
    ...envPaths.slice(0, MAX_PATH_DIRS)];
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const binaries: Record<string, boolean> = {};
  for (const name of SEARCH_BINARY_NAMES) {
    let found = false;
    for (const dir of dirs) {
      for (const suffix of suffixes) if (await exists(join(dir, name + suffix))) { found = true; break; }
      if (found) break;
    }
    binaries[name] = found;
  }
  return { binaries, pathLimited: envPaths.length > MAX_PATH_DIRS };
}

/** Read-only, bounded host observation. Never spawns a tool or opens source contents. */
export async function readRepositorySearchSnapshot(rootPath: string, provider: string): Promise<RepositorySearchSnapshot> {
  const root = resolve(rootPath);
  if (!(await stat(root)).isDirectory()) throw new Error("registered repository is not a directory");
  const [names, tools, config] = await Promise.all([inspectSourceNames(root), inspectBinaries(root), configuredServers(root, provider)]);
  return { root, provider, observedAt: new Date().toISOString(), ...names, ...tools, configuredServers: config };
}

/** Root identity is part of the cache key; a recreated checkout must be inspected again. */
export async function repositorySearchIdentity(rootPath: string): Promise<string> {
  const info = await stat(rootPath);
  return `${resolve(rootPath)}:${info.dev}:${info.ino}:${info.mtimeMs}`;
}
