/**
 * プロジェクトのルール本文をセッションへ届ける (application use case)。
 *
 * 起動案内の再計算 (`refreshStartupPolicy`) の後に呼ぶ。 登録が確定したプロジェクトと、
 * セッションが触った別リポ (`active_repos`) のプロジェクトを対象に、まだ届けていない /
 * 内容が変わったものだけを 1 プロジェクト 1 通で inject する。 届けたハッシュは inject を
 * 発行した直後に保存し、資料の読み込み中に別の再計算が先に届けた場合は、送信直前の
 * 再読込で二重送信を抑える。
 *
 * @implements spec/feature/project-rules-inject.md
 */

import { readFile, stat } from "node:fs/promises";
import type { ProjectCodeRow } from "../db/project-codes-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { eventBus } from "../events.js";
import { createProjectResolver } from "../projects/project-resolver.js";
import type { SessionRow } from "../shared/types.js";
import {
  buildProjectRulesText,
  collectProjectRules,
  PROJECT_RULES_INJECT_SOURCE,
  PROJECT_RULES_METADATA_KEY,
  readDeliveredProjectRules,
  selectUndelivered,
  type ProjectRulesTarget,
} from "./project-rules-inject.js";
import { selectStartupPolicyProject } from "./startup-policy-project.js";
import { isWorkspaceRootCwd } from "./session-work-policy.js";

/** ルール資料として読む 1 ファイルの上限 (バイト)。 巨大ファイルは読まずに不足扱いにする。 */
const MAX_RULE_FILE_BYTES = 512 * 1024;

export interface ProjectRulesDeliveryDeps {
  repo: Pick<SessionsRepo, "findSession" | "appendEvent" | "updateMetadata">;
  projects: () => readonly ProjectCodeRow[];
  workspaceRoots: () => readonly string[];
  readText?: (path: string) => Promise<string | null>;
  now?: () => number;
}

/** 登録が確定したプロジェクトと、触った別リポのプロジェクト (重複なし)。 */
export function projectRulesTargets(
  projects: readonly ProjectCodeRow[],
  session: Pick<SessionRow, "repo_path" | "repo_origin"> & Partial<Pick<SessionRow, "target_project" | "active_repos">>,
  workspaceRoots: readonly string[],
): ProjectRulesTarget[] {
  const targets = new Map<string, ProjectRulesTarget>();
  const resolver = createProjectResolver(projects);
  const primary = selectStartupPolicyProject(projects, session);
  // 起動直後の workspace root (Castra) は「登録が終わった」状態ではない。
  if (primary && !isWorkspaceRootCwd(session.repo_path, workspaceRoots)
    && resolver.codeForRepo(session.repo_path) === primary.code) {
    targets.set(primary.code, { code: primary.code, root: primary.repo_path });
  }
  for (const path of parseActiveRepos(session.active_repos)) {
    if (isWorkspaceRootCwd(path, workspaceRoots)) continue;
    const code = resolver.codeForRepo(path);
    const row = projects.find((candidate) => candidate.code === code);
    if (row && !targets.has(row.code)) targets.set(row.code, { code: row.code, root: row.repo_path });
  }
  return [...targets.values()];
}

export async function deliverProjectRules(deps: ProjectRulesDeliveryDeps, sessionId: string): Promise<string[]> {
  const session = deps.repo.findSession(sessionId);
  if (!session || session.status !== "active") return [];
  const targets = projectRulesTargets(deps.projects(), session, deps.workspaceRoots());
  if (targets.length === 0) return [];
  const readText = deps.readText ?? readRuleFile;
  const bundles = await Promise.all(targets.map((target) => collectProjectRules(target, readText)));

  // 読み込み中に別の再計算が届けていれば、その結果を尊重する。
  const latest = deps.repo.findSession(sessionId);
  if (!latest || latest.status !== "active") return [];
  const delivered = readDeliveredProjectRules(latest.metadata);
  const pending = selectUndelivered(bundles, delivered);
  const sent: string[] = [];
  for (const bundle of pending) {
    const text = buildProjectRulesText(bundle, delivered[bundle.code] ? "updated" : "registered");
    const ts = Math.floor((deps.now?.() ?? Date.now()) / 1000);
    deps.repo.appendEvent({ session_id: sessionId, ts, kind: "inject",
      payload: { source: PROJECT_RULES_INJECT_SOURCE, text, project: bundle.code, hash: bundle.hash } });
    eventBus.emit({ type: "session.inject", target_session_id: sessionId, text, source: PROJECT_RULES_INJECT_SOURCE, ts });
    deps.repo.updateMetadata(sessionId, (metadata) => ({
      ...metadata,
      [PROJECT_RULES_METADATA_KEY]: { ...readDeliveredFromObject(metadata), [bundle.code]: bundle.hash },
    }));
    sent.push(bundle.code);
  }
  return sent;
}

function parseActiveRepos(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
  } catch {
    return [];
  }
}

function readDeliveredFromObject(metadata: Record<string, unknown>): Record<string, string> {
  const value = metadata[PROJECT_RULES_METADATA_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function readRuleFile(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_RULE_FILE_BYTES) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
