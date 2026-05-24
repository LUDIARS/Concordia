/**
 * Rule Proposer — 固定機能.
 *
 * 5 分おきに「新しいチャット発言フック rule を提案するか」を AI に問う.
 * 既存の rule engine (default-tick) とは独立. tick で chat post する役割と
 * 「rule そのものを増やす」役割を分離して、 後者専用の loop を持つ.
 *
 * 出力 action: add_rule | skip のみ受け付ける. (post / remove は engine 側).
 */

import type { RulesRepo } from "../db/rules-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { ChatRepo } from "../db/chat-repo.js";
import { runClaude } from "./claude-runner.js";
import { handleAction } from "./handler.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("rule-proposer");

const DEFAULT_TICK_MS = 5 * 60 * 1000;       // 5 分 (admin で上書き可)
const STARTUP_DELAY_MS = 30 * 1000;  // 起動 30 秒後に初回

export interface ProposerDeps {
  rules: RulesRepo;
  sessions: SessionsRepo;
  chat: ChatRepo;
  /** test 用. true で claude CLI を呼ばずスキップ. */
  disable_claude?: boolean;
  /** enabled な ai 由来 rule 数がこれ以上なら新規提案を skip (rule 雪だるま防止). */
  maxAiRules?: number;
  /**
   * Runtime kill-switch (AdminState.getRulesEnabled() の否定を期待).
   * true で runOnce が claude を呼ばず skip する.
   */
  rulesDisabled?: () => boolean;
  /**
   * Tick interval in seconds. Default 300 (5 minutes). Read on each tick
   * via this getter so the Web UI can change cadence without restart.
   */
  intervalSec?: () => number;
}

export interface ProposerHandle {
  stop: () => void;
  runOnce: () => Promise<void>;
}

export function startRuleProposer(deps: ProposerDeps): ProposerHandle {
  let timer: NodeJS.Timeout | null = null;
  let firstTimer: NodeJS.Timeout | null = null;
  let running = false;
  let stopped = false;

  async function runOnce(): Promise<void> {
    if (stopped || running) return;
    if (deps.disable_claude || process.env.CONCORDIA_DISABLE_CLAUDE === "1") {
      return;
    }
    if (deps.rulesDisabled?.()) {
      // admin が rules-enabled=false にしている. tick は走らせるが claude を呼ばない.
      return;
    }

    running = true;
    try {
      const enabledRules = deps.rules.list({ enabled: true });

      // cap 判定: enabled な AI 由来 rule が上限以上なら claude を呼ばず skip
      const cap = deps.maxAiRules;
      if (typeof cap === "number" && cap >= 0) {
        const aiRuleCount = enabledRules.filter((r) => r.added_by === "ai").length;
        if (aiRuleCount >= cap) {
          deps.rules.log({
            rule_id: null,
            action: "skip",
            actor: "engine",
            detail: `proposer cap reached: ${aiRuleCount}/${cap} ai rules enabled`,
          });
          log.info({ aiRuleCount, cap }, "rule proposer skipped (cap reached)");
          return;
        }
      }

      const recentChat = deps.chat.list({ limit: 30 });
      const recentLogs = deps.rules.recentLogs(20);
      const activeSessions = deps.sessions.listSessions({ status: "active" });

      const ctx = {
        now_iso: new Date().toISOString(),
        active_session_count: activeSessions.length,
        existing_rules: enabledRules.map((r) => ({
          id: r.id,
          trigger_type: r.trigger_type,
          tick_sec: r.tick_sec,
          event_kind: r.event_kind,
          description: r.description,
        })),
        recent_chat: recentChat.map((m) => ({
          channel: m.channel,
          author: m.author_label,
          ts_sec_ago: Math.floor(Date.now() / 1000) - m.ts,
          text: m.text.slice(0, 80),
        })),
        recent_rule_actions: recentLogs.map((l) => ({
          action: l.action,
          rule_id: l.rule_id,
          actor: l.actor,
          detail: l.detail?.slice(0, 80),
        })),
      };

      const prompt = [
        "あなたは Concordia (LUDIARS multi-agent session coordinator) の **rule proposer** です.",
        "目的: 既存のチャット発言フック rule に足りないパターンを見つけ、 新しい rule を 1 つだけ提案するか、 提案すべきでないと判断したら skip すること.",
        "",
        "## 重要な制約",
        "- rule = **チャット発言フック** (いつ / どの channel に / 何を投稿するか). meta 管理ではない.",
        "- 既存 rule と意味的に重複する提案は禁止 (existing_rules を確認).",
        "- 5 分以内に同じ rule を再提案しないこと.",
        "- 提案する rule の id は kebab-case で 短く一意 (例: 'topic-shift-toast').",
        "- 何も提案する価値がないなら遠慮なく skip すること (むしろ skip がデフォルト).",
        "",
        "## 提案禁止パターン (これらを目的とする rule は提案しないこと — handler でも reject されます)",
        "- 無音 / 沈黙検知系 (例: 'long-silence-poke', '誰も発言していないことを知らせる'). 理由: event log で見えるので冗長.",
        "- 進捗 ping 系 (例: 'progress-check-ping', '進捗を聞き合う'). 理由: /v1/stat poll で完結.",
        "- ロール無関係な汎用雑談 (天気 / 時事 / 抽象的感想). 理由: persona の役割と紐づかない発話は noise.",
        "- 衝突確認 を skip して chat 開始するような rule. 理由: 衝突回避が会話より先 (作業競合の事故防止).",
        "",
        "## 出力 (JSON 1 つのみ、 余計な前置きなし)",
        `{"action":"add_rule","rule":{"id":"<id>","description":"<目的を 1 行>","trigger_type":"tick"|"event","tick_sec":<sec>?,"event_kind":"<kind>"?,"conditions":[],"instructions":"<AI に渡す具体的指示>","target":null,"cooldown_sec":<sec>},"reasoning":"<提案理由>"}`,
        `{"action":"skip","reasoning":"<提案する価値のあるパターンが見当たらない理由>"}`,
        "",
        "## 現在の状況",
        JSON.stringify(ctx, null, 2).slice(0, 12_000),
      ].join("\n");

      const r = await runClaude(prompt);
      if (!r.ok) {
        deps.rules.log({ rule_id: null, action: "error", actor: "engine", detail: `proposer claude failed: ${r.stderr.slice(0, 200)}` });
        return;
      }
      const json = parseJson(r.stdout);
      if (!json) {
        deps.rules.log({ rule_id: null, action: "error", actor: "engine", detail: "proposer unparseable" });
        return;
      }

      // proposer は add_rule / skip のみ許可
      const action = (json as any).action;
      if (action !== "add_rule" && action !== "skip") {
        deps.rules.log({
          rule_id: null,
          action: "error",
          actor: "engine",
          detail: `proposer returned disallowed action: ${action}`,
        });
        return;
      }

      const result = handleAction({ chat: deps.chat, rules: deps.rules }, "_proposer", json);
      log.info({ action, applied: result.applied, detail: result.detail }, "rule proposer tick");
    } catch (err) {
      log.warn({ err: (err as Error).message }, "proposer tick failed");
    } finally {
      running = false;
    }
  }

  // 初回 30 秒後 + 以降は admin 設定の間隔 (default 5 分). 再スケジュール式に
  // することで、 admin が runtime 中に PUT した interval を次の tick から反映できる.
  const getIntervalMs = (): number => {
    const sec = deps.intervalSec?.();
    return Number.isFinite(sec) && sec! > 0 ? Math.max(60_000, sec! * 1000) : DEFAULT_TICK_MS;
  };
  let currentInterval = getIntervalMs();
  function scheduleNext(): void {
    if (stopped) return;
    const next = getIntervalMs();
    if (next !== currentInterval) {
      log.info({ from_ms: currentInterval, to_ms: next }, "proposer interval changed");
      currentInterval = next;
    }
    timer = setTimeout(async () => {
      try {
        await runOnce();
      } finally {
        scheduleNext();
      }
    }, currentInterval);
  }
  firstTimer = setTimeout(() => {
    void runOnce().finally(scheduleNext);
  }, STARTUP_DELAY_MS);

  log.info({ tickMs: currentInterval, startupDelayMs: STARTUP_DELAY_MS }, "rule proposer started");

  return {
    stop: () => {
      stopped = true;
      if (firstTimer) clearTimeout(firstTimer);
      // timer は now setTimeout (re-scheduling pattern). clearTimeout で十分.
      if (timer) clearTimeout(timer);
    },
    runOnce,
  };
}

function parseJson(text: string): unknown | null {
  try { return JSON.parse(text.trim()); } catch { /* fall through */ }
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch { /* fall through */ } }
  const m = /\{[\s\S]*\}/.exec(text);
  if (m) { try { return JSON.parse(m[0]); } catch { return null; } }
  return null;
}
