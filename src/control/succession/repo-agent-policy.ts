/**
 * リポ担当エージェントへの受け渡しの判定 (純関数)。
 *
 * - checkout の解決 (登録リポ root / その配下の `.wt-*` worktree)
 * - ゲートの deny が「cwd と作業先のずれ」によるものかの判定 (INV-6)
 * - 担当を立てるかの判定と、 副契機 (リポ分岐) の候補抽出
 *
 * @implements spec/feature/session-auto-succession.md §3.1, §3.2 (CC-AUTO-SUCC-02, INV-6)
 */

/** 担当が「いる」とみなす行の状態 (§3.4 の requested〜active)。 */
export const LIVE_REPO_AGENT_STATUSES: ReadonlySet<string> = new Set(["requested", "spawning", "active"]);

/**
 * cwd と作業先のずれで起きる deny の rule。 担当へ渡せば解消するものだけを置く。
 * 秘密・危険コマンド・相談境界・main push 等の安全上の rule は入れない (INV-6)。
 * 新しい rule を足すときはここだけ直す。
 */
const REPO_MISMATCH_RULES: ReadonlySet<string> = new Set([
  "task-branch",
  "contract-incomplete",
  "outside-scope",
  "max-repos",
]);

export interface GateHitLike {
  rule: string;
  decision: string;
}

export function isRepoMismatchDenial(hit: GateHitLike): boolean {
  return hit.decision === "deny" && REPO_MISMATCH_RULES.has(hit.rule);
}

/** 比較用のキー (区切り統一・末尾 / 除去・大小無視)。 Windows のパスは大小を区別しない。 */
export function repoKey(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function slashed(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

/** 最長一致の登録リポ root を返す。 一致なしは null。 */
export function resolveRegisteredRepo(path: string, registeredRepos: readonly string[]): string | null {
  const key = repoKey(path);
  if (!key) return null;
  let best: string | null = null;
  let bestLength = -1;
  for (const repo of registeredRepos) {
    const repoKeyValue = repoKey(repo);
    if (!repoKeyValue) continue;
    const matches = key === repoKeyValue || key.startsWith(`${repoKeyValue}/`);
    if (matches && repoKeyValue.length > bestLength) {
      best = slashed(repo);
      bestLength = repoKeyValue.length;
    }
  }
  return best;
}

export interface ResolvedCheckout {
  /** 担当の cwd になる checkout (登録リポ root か、 その直下の `.wt-*` worktree)。 */
  checkout: string;
  /** checkout が属する登録リポ root。 */
  repo: string;
}

/** path を checkout へ解決する。 `<repo>/.wt-x/...` は `<repo>/.wt-x`、 それ以外は `<repo>`。 */
export function resolveCheckout(path: string, registeredRepos: readonly string[]): ResolvedCheckout | null {
  const repo = resolveRegisteredRepo(path, registeredRepos);
  if (!repo) return null;
  const rest = slashed(path).slice(repo.length).replace(/^\/+/, "");
  const first = rest.split("/")[0] ?? "";
  if (first.toLowerCase().startsWith(".wt-")) return { checkout: `${repo}/${first}`, repo };
  return { checkout: repo, repo };
}

export function sameCheckout(left: string | null, right: string | null): boolean {
  return left !== null && right !== null && repoKey(left) === repoKey(right);
}

export type RepoAgentSkipReason =
  | "disabled"
  | "not_spawnable"
  | "managed_elsewhere"
  | "unregistered"
  | "same_checkout"
  | "already_assigned"
  | "agent_limit"
  | "session_ending";

export interface RepoAgentHandoffInput {
  parentStatus: string;
  /** 親の provider が spawn 可能 (Claude / Codex)。 */
  spawnable: boolean;
  /** 親がリポ担当・委託子・パートタイマー自身 (再帰防止)。 */
  managedElsewhere: boolean;
  /** 親の起動 cwd の checkout。 登録外 (ワークスペースルート等) なら起動 cwd そのもの。 */
  launchCheckout: string | null;
  /** 対象 checkout。 登録プロジェクトに解決できなければ null。 */
  target: ResolvedCheckout | null;
  /** 親の担当行 (checkout と状態)。 */
  agents: ReadonlyArray<{ checkout: string; status: string }>;
  sessionEnding: boolean;
}

export type RepoAgentHandoffDecision =
  | { action: "assign"; target: ResolvedCheckout }
  | { action: "skip"; reason: RepoAgentSkipReason };

export function decideRepoAgentHandoff(
  input: RepoAgentHandoffInput,
  settings: { enabled: boolean; maxAgentsPerParent: number },
): RepoAgentHandoffDecision {
  if (!settings.enabled) return { action: "skip", reason: "disabled" };
  if (input.parentStatus !== "active" || !input.spawnable) return { action: "skip", reason: "not_spawnable" };
  if (input.managedElsewhere) return { action: "skip", reason: "managed_elsewhere" };
  if (!input.target) return { action: "skip", reason: "unregistered" };
  if (sameCheckout(input.launchCheckout, input.target.checkout)) return { action: "skip", reason: "same_checkout" };
  const live = input.agents.filter((agent) => LIVE_REPO_AGENT_STATUSES.has(agent.status));
  if (live.some((agent) => sameCheckout(agent.checkout, input.target!.checkout))) {
    return { action: "skip", reason: "already_assigned" };
  }
  if (live.length >= settings.maxAgentsPerParent) return { action: "skip", reason: "agent_limit" };
  if (input.sessionEnding) return { action: "skip", reason: "session_ending" };
  return { action: "assign", target: input.target };
}

/**
 * 副契機 (§3.1 02b): 触ったリポのうち、 起動 cwd の checkout と異なる登録 checkout を返す。
 * ワークスペースルートは候補にしない。 重複は除く。 担当の有無は decideRepoAgentHandoff が見る。
 */
export function branchedCheckouts(input: {
  launchCheckout: string | null;
  activeRepos: readonly string[];
  registeredRepos: readonly string[];
  workspaceRoots: readonly string[];
}): ResolvedCheckout[] {
  const roots = new Set(input.workspaceRoots.map(repoKey));
  const seen = new Set<string>();
  const out: ResolvedCheckout[] = [];
  for (const path of input.activeRepos) {
    if (roots.has(repoKey(path))) continue;
    const resolved = resolveCheckout(path, input.registeredRepos);
    if (!resolved || roots.has(repoKey(resolved.checkout))) continue;
    if (sameCheckout(input.launchCheckout, resolved.checkout)) continue;
    const key = repoKey(resolved.checkout);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

/** 起動 cwd の checkout。 登録リポに解決できなければ起動 cwd そのもの (空なら null)。 */
export function launchCheckoutOf(repoPath: string, registeredRepos: readonly string[]): string | null {
  const resolved = resolveCheckout(repoPath, registeredRepos);
  if (resolved) return resolved.checkout;
  const raw = slashed(repoPath);
  return raw.length > 0 ? raw : null;
}
