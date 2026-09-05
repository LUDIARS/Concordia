/**
 * RWF の「絵文字 → スキル」写像 (設計 §10.2 C-9 / §11)。
 *
 * 組み込みアクションのうち **プロンプトを inject / headless で流すもの**は、
 * プロンプト本文を Castra のスキル (`.claude/skills/<name>/SKILL.md`、
 * `.claude/commands/<name>.md`) へ移し、 Cc 側は「どの絵文字がどのスキルを呼ぶか」
 * だけを持つ。 機械的操作 (Cc API 直叩き・CR 送信) はスキル化せず組み込みのまま残す。
 *
 * ここが持つのは純粋な写像と計画づくりだけ。 JSON の読み書きは
 * `reaction-workflow-store.ts`、 実行は `reaction-workflow.ts` の Runner。
 *
 * @implements spec/feature/reaction-workflow.md §1 — 絵文字 → スキル 写像
 * @implements SPEC-RWF-SKILL-ENTRY
 * @implements SPEC-RWF-SKILL-ENTRY-SHAPE
 */

import type { SkillCatalogEntry } from "../skills/catalog.js";
import { isWorkflowAction, type WorkflowAction } from "./reaction-workflow-action.js";
import {
  clipWorkflowText,
  isSkillWorkflowEntry,
  normalizeWorkflowEmoji,
  workflowMessageReference,
  workflowPromptHead,
  type CustomSkillWorkflowEntry,
  type CustomWorkflowEntry,
  type WorkflowContext,
  type WorkflowMode,
  type WorkflowModels,
  type WorkflowPlan,
} from "./reaction-workflow-plan.js";

/**
 * スキル化せず組み込みのまま残すアクション (設計 §11.1)。 いずれも Cc API 直叩き
 * または CR 送信で、 LLM を必要としない。
 */
export const BUILTIN_ONLY_ACTIONS: ReadonlySet<WorkflowAction> = new Set<WorkflowAction>([
  "force-enter",
  "channel-rename",
  "submit-pr",
  "list-local-prs",
]);

/**
 * 🧠 だけは組み込みの read model (`ReactionWorkflowDeps.contextReport`) が先に答える。
 * スキル `context-report` は read model を使えないときの inject 経路として残る
 * (`.claude/skills/context-report/SKILL.md` の「実行手段 (RWF)」節と同じ取り決め)。
 */
export const READ_MODEL_FIRST_ACTIONS: ReadonlySet<WorkflowAction> = new Set<WorkflowAction>([
  "context",
]);

/** 🪬 = プロジェクト設定 `project_codes.domain_review` が OFF なら実行しないアクション。 */
export const DOMAIN_REVIEW_ACTION: WorkflowAction = "domain-review";

/** 絵文字でスキルエントリを引く (異体字の有無を無視して照合する)。 */
export function matchSkillEntry(
  entries: readonly CustomWorkflowEntry[],
  emoji: string,
): CustomSkillWorkflowEntry | null {
  const target = normalizeWorkflowEmoji(emoji);
  if (!target) return null;
  for (const entry of entries) {
    if (!isSkillWorkflowEntry(entry)) continue;
    if (normalizeWorkflowEmoji(entry.emoji) === target) return entry;
  }
  return null;
}

/** action でスキルエントリを引く (管理設定の 絵文字→action 上書きから辿る経路)。 */
export function findSkillEntryForAction(
  entries: readonly CustomWorkflowEntry[],
  action: WorkflowAction,
): CustomSkillWorkflowEntry | null {
  for (const entry of entries) {
    if (isSkillWorkflowEntry(entry) && entry.action === action) return entry;
  }
  return null;
}

/**
 * 実行手段の解決。 `mode: inject` のスキルは authoring session が非 active なら
 * headless へ落ちる (移行前の組み込み実装と同じ二段構え)。
 */
export function resolveSkillMode(
  entry: CustomSkillWorkflowEntry,
  sessionActive: boolean,
): WorkflowMode {
  if (entry.mode === "headless") return "headless";
  return sessionActive ? "inject" : "headless";
}

/**
 * `--model` を必ず確定させる。 既定任せで spawn すると上限切れの巻き添えで即 exit
 * するため、 headless では常に明示する。
 */
export function resolveSkillModel(
  entry: CustomSkillWorkflowEntry,
  models: WorkflowModels,
): string {
  const alias = (entry.model ?? "").trim() || "sonnet";
  if (alias === "haiku") return models.haiku;
  if (alias === "sonnet") return models.sonnet;
  if (alias === "opus") return models.opus ?? "opus";
  return alias;
}

/** cwd トークン (repo / memoria / castra) または絶対パスを実パスへ解決する。 */
export function resolveSkillCwd(
  token: string | null | undefined,
  ctx: WorkflowContext,
): string | undefined {
  const value = (token ?? "repo").trim();
  if (value === "repo") return ctx.repoPath ?? ctx.workspaceRoot ?? undefined;
  if (value === "memoria") return ctx.memoriaPath;
  if (value === "castra" || value === "ars" || value === "workspace") {
    return ctx.workspaceRoot ?? undefined;
  }
  return value;
}

/** スキル呼び出しの 1 行 (`/<skill> <args>`)。 */
export function skillInvocation(entry: CustomSkillWorkflowEntry): string {
  const args = (entry.args ?? "").trim();
  return args ? `/${entry.skill} ${args}` : `/${entry.skill}`;
}

export type SkillPlanResult =
  | { ok: true; plan: WorkflowPlan }
  | { ok: false; reason: "skill_body_unavailable"; detail: string };

/**
 * スキルエントリから実行計画を組む。
 *
 *  - inject: authoring session へ `/<skill> <args>` を流す (スキル名は session 側で解決される)。
 *  - headless: **SKILL.md の本文をシステム文脈として渡す** — headless の `claude -p` は
 *    スキル名を解決しないため、 本文が無ければ実行できない (その旨を理由として返す)。
 *
 * 対象メッセージは inject / headless のどちらでも `<reaction-message-data>` で
 * 囲んだ信頼できない外部データとして渡す。
 */
export function planSkillWorkflow(input: {
  entry: CustomSkillWorkflowEntry;
  action: WorkflowAction;
  ctx: WorkflowContext;
  /** SKILL.md 本文 (headless のときだけ必要)。 */
  skillBody: string | null;
  /** 本文の出所 (プロンプトへ明示する)。 */
  skillPath?: string | null;
  models: WorkflowModels;
}): SkillPlanResult {
  const { entry, action, ctx, models } = input;
  const mode = resolveSkillMode(entry, ctx.sessionActive);
  const invocation = skillInvocation(entry);

  if (mode === "inject") {
    return {
      ok: true,
      plan: {
        action,
        mode: "inject",
        prompt: `${invocation}${workflowMessageReference(ctx)}`,
      },
    };
  }

  const body = (input.skillBody ?? "").trim();
  if (!body) {
    return {
      ok: false,
      reason: "skill_body_unavailable",
      detail: `スキル "${entry.skill}" の本文を読めませんでした (.claude/skills または .claude/commands に在りますか)`,
    };
  }
  const source = input.skillPath ? ` (${input.skillPath})` : "";
  const prompt =
    `${workflowPromptHead(ctx)}\n` +
    `以下は Castra のスキル \`${entry.skill}\`${source} の本文です。 この手順に従って作業してください。\n` +
    `<skill-instructions name=${JSON.stringify(entry.skill)}>\n` +
    `${clipWorkflowText(body, 24_000)}\n` +
    `</skill-instructions>\n\n` +
    `実行するコマンド: ${invocation}\n`;
  return {
    ok: true,
    plan: {
      action,
      mode: "headless",
      model: resolveSkillModel(entry, models),
      cwd: resolveSkillCwd(entry.cwd, ctx),
      prompt,
    },
  };
}

/** 移行結果。 取りこぼした絵文字を機械的に見えるようにする。 */
export interface SkillWorkflowSeed {
  /** 生成された 絵文字 → スキル エントリ。 */
  entries: CustomSkillWorkflowEntry[];
  /** 組み込みにあるのにスキル割り当てが見つからなかった絵文字 (= 取りこぼし)。 */
  uncovered: string[];
  /** スキル側だけが宣言している絵文字 (組み込みに無い新規割り当て、 例 📑 / 🪬)。 */
  added: string[];
  /** スキル名を解決できなかった宣言 (カタログに載っていない skill 名など)。 */
  notes: string[];
}

/** 走査結果のうち seed が必要とする部分だけ (テストからフィクスチャを渡せる形)。 */
export type SkillSeedSource = Pick<SkillCatalogEntry, "name" | "rwf">;

/**
 * `WORKFLOW_EMOJI` を seed として「絵文字 → skill エントリ」へ変換する (設計 §11.2 の 2)。
 *
 * 割り当ての正本は **スキル側 frontmatter の `metadata.rwf`**。 組み込み写像は
 * 「どの絵文字が覆われるべきか」の期待値として使い、 覆われなかったものを
 * `uncovered` に返す。 組み込み据え置き (`BUILTIN_ONLY_ACTIONS`) と予約絵文字は対象外。
 */
export function buildSkillWorkflowSeed(input: {
  catalog: readonly SkillSeedSource[];
  /** 組み込み写像 (action → 絵文字群)。 */
  builtinEmoji: Readonly<Record<WorkflowAction, readonly string[]>>;
  /** 予約絵文字 (👌 等) の判定。 */
  isReservedEmoji: (emoji: string) => boolean;
}): SkillWorkflowSeed {
  const { catalog, builtinEmoji, isReservedEmoji } = input;
  const builtinByEmoji = new Map<string, WorkflowAction>();
  for (const [action, emojis] of Object.entries(builtinEmoji) as [WorkflowAction, readonly string[]][]) {
    if (BUILTIN_ONLY_ACTIONS.has(action)) continue;
    for (const emoji of emojis) builtinByEmoji.set(normalizeWorkflowEmoji(emoji), action);
  }

  const entries: CustomSkillWorkflowEntry[] = [];
  const notes: string[] = [];
  const added: string[] = [];
  const covered = new Set<string>();

  for (const skill of catalog) {
    for (const binding of skill.rwf) {
      const declaredAction = binding.action && isWorkflowAction(binding.action) ? binding.action : null;
      if (binding.action && !declaredAction) {
        notes.push(`unknown action "${binding.action}" declared by skill ${skill.name}`);
      }
      for (const emoji of binding.emoji) {
        if (isReservedEmoji(emoji)) {
          notes.push(`reserved emoji ${emoji} skipped (skill ${skill.name})`);
          continue;
        }
        const key = normalizeWorkflowEmoji(emoji);
        if (!key || covered.has(key)) continue;
        const builtinAction = builtinByEmoji.get(key) ?? null;
        if (builtinAction && declaredAction && declaredAction !== builtinAction) {
          notes.push(
            `emoji ${emoji} (skill ${skill.name}) declares action ${declaredAction}, ` +
            `but builtin action is ${builtinAction} — skipped`,
          );
          continue;
        }
        // 組み込み絵文字の action は権限判定の正本。スキル metadata で弱い action に
        // 差し替えると capability check を迂回できるため、常に組み込み側を採用する。
        const action = builtinAction ?? declaredAction;
        if (!action) {
          notes.push(`emoji ${emoji} (skill ${skill.name}) has no resolvable action — skipped`);
          continue;
        }
        if (BUILTIN_ONLY_ACTIONS.has(action)) {
          notes.push(`emoji ${emoji} maps to builtin-only action ${action} — kept builtin`);
          continue;
        }
        covered.add(key);
        if (!builtinByEmoji.has(key)) added.push(emoji);
        entries.push({
          kind: "skill",
          emoji,
          skill: skill.name,
          ...(binding.args ? { args: binding.args } : {}),
          mode: binding.mode,
          ...(binding.model ? { model: binding.model } : {}),
          ...(binding.cwd ? { cwd: binding.cwd } : {}),
          action,
        });
      }
    }
  }

  const uncovered: string[] = [];
  for (const [action, emojis] of Object.entries(builtinEmoji) as [WorkflowAction, readonly string[]][]) {
    if (BUILTIN_ONLY_ACTIONS.has(action)) continue;
    for (const emoji of emojis) {
      if (isReservedEmoji(emoji)) continue;
      if (!covered.has(normalizeWorkflowEmoji(emoji))) uncovered.push(emoji);
    }
  }

  return { entries, uncovered, added, notes };
}

/**
 * 既存の JSON へスキルエントリを取り込む。 自由プロンプトのエントリ (add-as-workflow で
 * 登録したもの) は消さずに残し、 同じ絵文字のスキルエントリだけ入れ替える。
 */
export function mergeSkillEntries(
  existing: readonly CustomWorkflowEntry[],
  incoming: readonly CustomSkillWorkflowEntry[],
): CustomWorkflowEntry[] {
  const incomingKeys = new Set(incoming.map((entry) => normalizeWorkflowEmoji(entry.emoji)));
  const kept = existing.filter(
    (entry) => !isSkillWorkflowEntry(entry) || !incomingKeys.has(normalizeWorkflowEmoji(entry.emoji)),
  );
  return [...kept, ...incoming];
}
