import { execFile } from "node:child_process";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// Keep this aligned with Lictor's per-session skill injector. The same content
// is also sent as a Session inject, so rejecting oversized skills here avoids
// creating an unexpectedly large prompt when the sidecar cannot persist it.
const MAX_SKILL_BYTES = 32 * 1024;

export interface SessionSkillSource {
  name: string;
  relativePath: string;
}

export interface LoadedSessionSkill extends SessionSkillSource {
  content: string;
}

/** List only skill files committed/checked out in this Session's repo_path. */
export async function listSessionSkillSources(repoPath: string): Promise<SessionSkillSource[]> {
  const repoReal = await realpath(repoPath);
  const found = new Map<string, SessionSkillSource>();
  for (const base of [".claude/skills", ".agents/skills", ".codex/skills"]) {
    const dir = resolve(repoReal, base);
    for (const entry of await safeReadDir(dir)) {
      if (!entry.isDirectory() || !SKILL_NAME_RE.test(entry.name)) continue;
      const candidate = join(dir, entry.name, "SKILL.md");
      if (!(await isSafeFile(repoReal, candidate))) continue;
      if (!found.has(entry.name)) {
        found.set(entry.name, { name: entry.name, relativePath: slash(relative(repoReal, candidate)) });
      }
    }
  }

  // Concordia authors its distributable repo skill at src/skills/<name>.md.
  // Supporting this source keeps /cc-skill branch-aware before sync:skill runs.
  const authoredDir = resolve(repoReal, "src/skills");
  for (const entry of await safeReadDir(authoredDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const name = basename(entry.name, ".md");
    if (!SKILL_NAME_RE.test(name) || found.has(name)) continue;
    const candidate = join(authoredDir, entry.name);
    if (!(await isSafeFile(repoReal, candidate))) continue;
    found.set(name, { name, relativePath: slash(relative(repoReal, candidate)) });
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadSessionSkill(repoPath: string, name: string): Promise<LoadedSessionSkill | null> {
  if (!SKILL_NAME_RE.test(name)) return null;
  const source = (await listSessionSkillSources(repoPath)).find((item) => item.name === name);
  if (!source) return null;
  const file = resolve(repoPath, source.relativePath);
  const info = await stat(file);
  if (info.size > MAX_SKILL_BYTES) throw new Error(`skill ${name} exceeds ${MAX_SKILL_BYTES} bytes`);
  return { ...source, content: await readFile(file, "utf8") };
}

export async function readWorkingBranch(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      process.platform === "win32" ? "git.exe" : "git",
      ["branch", "--show-current"],
      { cwd: repoPath, encoding: "utf8", timeout: 3000, windowsHide: true },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function safeReadDir(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function isSafeFile(repoReal: string, candidate: string): Promise<boolean> {
  try {
    const candidateReal = await realpath(candidate);
    const rel = relative(repoReal, candidateReal);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || resolve(repoReal, rel) !== candidateReal) return false;
    return (await stat(candidateReal)).isFile();
  } catch {
    return false;
  }
}

function slash(value: string): string {
  return value.replace(/\\/g, "/");
}
