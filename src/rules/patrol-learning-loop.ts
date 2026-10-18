/**
 * 巡回チャットの学習の手順 (spec/plan/2026-10-15-patrol-learning-design.md)。
 *
 * 1 回の pass で:
 *   1. 受理済みの返信から発言の断片を作る (最大 2 件、 rule ごと 1 日 20 件まで。 LLM 1 回ずつ、 再試行なし)
 *   2. 閉じた会話から決定的な断片を作る (反応の人数・返信数)
 *   3. ローカル 04:00 以降なら、 その日まだ学習していない rule を 1 本だけ学習して自動反映する。
 *      反応の良かったトレンドの題・語に関係する知識の断片を材料に足し、 「次に寄せる関連話題」を方針に書けるようにする
 *      (spec/feature/patrol-chat.md「知識」)。 学習結果には断片の出典 (doc_key / 題) だけを残し、 本文は残さない
 *
 * 返信の応答 (patrol-cycle) とは別の流れで動き、 返信を待たせない。
 */

import type { PatrolLearningRepo } from "../db/patrol-learning-repo.js";
import type { RuleVersionsRepo } from "../db/rule-versions-repo.js";
import type { RuleRow, RulesRepo } from "../db/rules-repo.js";
import { PatrolActionConfigInput, parseActionConfig, type PatrolActionConfig, type SubsidiaryPatrolDefaults } from "./patrol-config.js";
import { allowsHqKnowledge } from "./knowledge-scope.js";
import type { KnowledgeQuery } from "./knowledge-select.js";
import type { KnowledgeChunk } from "./knowledge-types.js";
import {
  LEARNING_LIMITS,
  applyLearningProposal,
  buildExtractPrompt,
  buildLearningPrompt,
  digestFragments,
  isLearningHour,
  learningKnowledgeRefs,
  localDay,
  parseLearningProposal,
  parseMessageSignal,
  topKeywords,
  type ConversationSignal,
  type FragmentDigest,
} from "./patrol-learning.js";
import type { LearningJournalSync } from "./patrol-learning-journal.js";
import { dayStartSec, type PatrolReactionsPort } from "./patrol-ports.js";
import type { OneShotRunner } from "./render-patrol.js";
import type { ReviewResult } from "./review.js";

export interface LearningLoopDeps {
  repo: PatrolLearningRepo;
  rules: Pick<RulesRepo, "list" | "find" | "updateWithRevision" | "setNextDue" | "log">;
  versions: Pick<RuleVersionsRepo, "record"> | null;
  reactions: PatrolReactionsPort | null;
  runner: OneShotRunner;
  /** 反映前の検証 (更新後の全体を validateRuleDefinition で)。 */
  validate: (rule: RuleRow, actionConfigJson: string, tickSec: number) => ReviewResult;
  /** 持ち主の子会社の既定値。 */
  inherit: (rule: RuleRow) => SubsidiaryPatrolDefaults | null;
  /** 投稿先チャンネル (個別チャンネル) の rule。 返信でない会話の断片をどの rule に付けるか。 */
  ruleForChannel?: (discordChannelId: string) => RuleRow | null;
  /** 知識の断片の選択 (spec/feature/patrol-chat.md「知識」)。 未注入なら知識なしで学習する。 */
  knowledge?: { select(query: KnowledgeQuery): KnowledgeChunk[] } | null;
  /** 巡回が止まっている間は学習もしない。 */
  disabled?: () => boolean;
  /** その日の学習の記録を Memoria の日記へ載せる (未注入なら載せない)。 */
  journal?: LearningJournalSync | null;
  nowMs: () => number;
  newId: () => string;
  log?: { warn: (msg: string) => void };
}

export interface LearningPassReport {
  messageFragments: number;
  conversationFragments: number;
  learned: { ruleId: string; status: string; reason: string | null } | null;
}

const EXTRACT_TIMEOUT_MS = 30_000;
const LEARN_TIMEOUT_MS = 60_000;

function learningEnabled(rule: RuleRow): boolean {
  try {
    const raw = JSON.parse(rule.action_config ?? "{}") as { learning?: { enabled?: unknown } };
    return raw.learning?.enabled !== false;
  } catch {
    return false;
  }
}

export async function runLearningPass(deps: LearningLoopDeps): Promise<LearningPassReport> {
  const report: LearningPassReport = { messageFragments: 0, conversationFragments: 0, learned: null };
  if (deps.disabled?.()) return report;
  const now = Math.floor(deps.nowMs() / 1000);
  const since = now - 2 * 86400;
  const today = dayStartSec(now);

  // 1. 発言の断片 (巡回への返信 + 投稿先チャンネルの返信でない会話)
  const candidates: Array<{ chatId: number; ruleId: string | null; text: string }> = [
    ...deps.repo.pendingReplies(since, LEARNING_LIMITS.extractPerPass * 5)
      .map((r) => ({ chatId: r.inbound_chat_id, ruleId: r.rule_id, text: r.text })),
    ...deps.repo.pendingChannelMessages(since, LEARNING_LIMITS.extractPerPass * 5)
      .map((m) => ({ chatId: m.chat_id, ruleId: deps.ruleForChannel?.(m.discord_channel_id)?.id ?? null, text: m.text })),
  ];
  let extracted = 0;
  for (const c of candidates) {
    if (extracted >= LEARNING_LIMITS.extractPerPass) break;
    const sourceKey = `msg:${c.chatId}`;
    const rule = c.ruleId ? deps.rules.find(c.ruleId) : null;
    if (!rule || !learningEnabled(rule)) {
      deps.repo.insertFragment({ rule_id: c.ruleId ?? "", kind: "message", source_key: sourceKey, status: "failed", signal: { skipped: "no learning rule" }, now });
      continue;
    }
    if (deps.repo.countMessageFragmentsSince(rule.id, today) >= LEARNING_LIMITS.messageFragmentsPerDay) {
      deps.repo.insertFragment({ rule_id: rule.id, kind: "message", source_key: sourceKey, status: "failed", signal: { skipped: "daily cap" }, now });
      continue;
    }
    extracted++;
    let signal = null;
    try {
      const res = await deps.runner(buildExtractPrompt(c.text), { model: "haiku", timeoutMs: EXTRACT_TIMEOUT_MS, conversationOnly: true });
      signal = res.ok ? parseMessageSignal(res.stdout) : null;
    } catch (err) {
      deps.log?.warn(`patrol learning: extract failed (chat #${c.chatId}): ${(err as Error).message}`);
    }
    deps.repo.insertFragment({ rule_id: rule.id, kind: "message", source_key: sourceKey, status: signal ? "ok" : "failed", signal, now });
    if (signal) report.messageFragments++;
  }

  // 2. 会話の断片 (決定的)
  for (const conv of deps.repo.closedConversations(since, 20)) {
    const r = deps.reactions?.reactorsByMessage(conv.root_chat_id) ?? { distinct: 0, fine: 0, bad: 0 };
    const signal: ConversationSignal = {
      replies: conv.reply_count, followups: conv.unprompted_count, reactors: r.distinct, fine: r.fine, bad: r.bad,
      title: conv.material_title ?? null,
    };
    if (deps.repo.insertFragment({ rule_id: conv.rule_id, kind: "conversation", source_key: `conv:${conv.conversation_id}`, status: "ok", signal, now })) {
      report.conversationFragments++;
    }
  }

  // 3. 1 日ごとの学習 (1 pass で 1 rule まで)
  if (isLearningHour(now)) {
    const day = localDay(now);
    const target = deps.rules.list({ execution_mode: "patrol" })
      .find((r) => r.enabled && !r.removed_at && learningEnabled(r) && !deps.repo.hasRun(r.id, day));
    if (target) report.learned = await learnRule(deps, target, day, now);
  }
  // 変わった日だけ送る。 送れなければ次の pass でもう一度送る。 学習そのものは止めない。
  try {
    await deps.journal?.sync();
  } catch (err) {
    deps.log?.warn(`patrol learning journal: ${(err as Error).message}`);
  }
  return report;
}

async function learnRule(deps: LearningLoopDeps, rule: RuleRow, day: string, now: number): Promise<{ ruleId: string; status: string; reason: string | null }> {
  const runId = deps.newId();
  const fragments = deps.repo.unconsumed(rule.id);
  const record = (status: "applied" | "skipped" | "rejected" | "failed", reason: string | null, extra: { proposal?: unknown; applied?: unknown; revision?: number | null; consume?: boolean } = {}) => {
    deps.repo.recordRun({
      run_id: runId, rule_id: rule.id, day, status, fragment_count: fragments.length,
      proposal: extra.proposal === undefined ? null : JSON.stringify(extra.proposal),
      applied: extra.applied === undefined ? null : JSON.stringify(extra.applied),
      reason, revision: extra.revision ?? null, now,
    });
    if (extra.consume) deps.repo.consume(fragments.map((f) => f.id), runId);
    deps.rules.log({ rule_id: rule.id, action: status === "failed" ? "error" : "skip", actor: "engine", detail: `learning ${day}: ${status}${reason ? ` (${reason})` : ""}` });
    return { ruleId: rule.id, status, reason };
  };

  if (fragments.length < LEARNING_LIMITS.minFragments) {
    return record("skipped", `not enough fragments (${fragments.length}/${LEARNING_LIMITS.minFragments})`);
  }
  let raw: PatrolActionConfigInput;
  try {
    raw = PatrolActionConfigInput.parse(JSON.parse(rule.action_config ?? "{}"));
  } catch {
    return record("failed", "invalid action_config");
  }
  const effective = parseActionConfig(rule.action_config, deps.inherit(rule));
  if (!effective.ok) return record("failed", effective.reason);
  const current = { tick_sec: rule.tick_sec ?? 1800, config: raw, effectiveRootLimit: effective.config.root_limit_per_day };
  const digest = digestFragments(fragments.map((f) => ({ kind: f.kind, signal: f.signal ? JSON.parse(f.signal) : null })));
  const related = relatedKnowledge(deps, rule, effective.config, digest);
  const refs = learningKnowledgeRefs(related);
  const withRefs = (proposal: unknown) => (refs.length && proposal && typeof proposal === "object" ? { ...proposal, related_knowledge: refs } : proposal);

  let output: string;
  try {
    const res = await deps.runner(buildLearningPrompt(digest, current, related.map((c) => ({ title: c.title, body: c.body }))), { model: "haiku", timeoutMs: LEARN_TIMEOUT_MS, conversationOnly: true });
    if (!res.ok) return record("failed", `learning render failed: ${res.stderr.slice(0, 160)}`);
    output = res.stdout;
  } catch (err) {
    return record("failed", `learning render failed: ${(err as Error).message}`);
  }
  const proposal = parseLearningProposal(output);
  if (!proposal) return record("rejected", "unparsable proposal", { consume: true });

  const applied = applyLearningProposal(proposal, current, now);
  // 会話によく出た話題のキーワードを、 サーバーの関心キーワード (learned.keywords) として置き換える (決定的)。
  const keywords = topKeywords(digest.keywordCounts, 10);
  if (keywords.length > 0) {
    applied.config.learned = { ...(applied.config.learned ?? {}), keywords, updated_at: now };
    applied.changes.learned_keywords = keywords;
  }
  if (Object.keys(applied.changes).length === 0) {
    return record("skipped", "no change", { proposal: withRefs(proposal), consume: true });
  }
  const configJson = JSON.stringify(applied.config);
  const review = deps.validate(rule, configJson, applied.tick_sec);
  if (!review.ok) return record("rejected", review.reason, { proposal: withRefs(proposal), consume: true });

  const updated = deps.rules.updateWithRevision(rule.id, rule.revision, {
    action_config: configJson,
    tick_sec: applied.tick_sec,
    cooldown_sec: applied.tick_sec,
  });
  if (!updated) return record("failed", "revision conflict", { proposal: withRefs(proposal) });
  if (applied.tick_sec !== rule.tick_sec) deps.rules.setNextDue(rule.id, null);
  deps.versions?.record(updated, "learning", `learned ${day}: ${proposal.summary}`.slice(0, 300));
  return record("applied", proposal.summary || null, { proposal: withRefs(proposal), applied: applied.changes, revision: updated.revision, consume: true });
}

/**
 * 反応の良かったトレンドの題と、 会話によく出た語で知識を引く。 宛先の公開範囲は生成と同じ (CC-PATROL-05)。
 * 読めなくても学習は止めない。
 */
function relatedKnowledge(deps: LearningLoopDeps, rule: RuleRow, config: PatrolActionConfig, digest: FragmentDigest): KnowledgeChunk[] {
  if (!deps.knowledge) return [];
  const texts = [...digest.engagedTopics, ...topKeywords(digest.keywordCounts, 10)].filter((t) => t.trim());
  if (texts.length === 0) return [];
  const allowHq = allowsHqKnowledge({
    subsidiaryId: rule.subsidiary_id ?? null,
    scopeKey: config.scope_key,
    discordChannelId: config.discord_channel_id,
  });
  try {
    return deps.knowledge.select({ texts, allowHq }).filter((c) => allowHq || c.scope === "public");
  } catch {
    return [];
  }
}
