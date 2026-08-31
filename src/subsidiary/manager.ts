/**
 * 子会社 Bot のライフサイクル管理。 enabled な子会社の Bot を起動/停止/再起動する。
 *
 * Discord 子会社は `startDiscordBot` を子会社モード (deps.subsidiary) で起動し、
 * 本社 Bot と同じ 3 カテゴリ自動作成 + subsidiary-only 可視 + ガードゲートを得る。
 *
 * spec/feature/subsidiary-delegation.md §6。
 */

import type { SubsidiaryRepo } from "../db/subsidiary-repo.js";
import type { HarnessRulesRepo } from "../db/harness-rules-repo.js";
import type { DelegationRepo } from "../db/delegation-repo.js";
import type { DelegationService } from "../delegation/service.js";
import { processSubsidiaryRequest } from "./gate.js";
import type { RunClaudeFn } from "../rules/claude-runner.js";
import type { SubsidiaryBudgetTracker } from "./budget.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("subsidiary/manager");

/** 本社 Discord bot と共有する deps (接続設定と subsidiary だけ差し替える)。 */
export type BaseDiscordDeps = object;

export interface SubsidiaryBotEnv {
  enabled: boolean;
  token: string | null;
  guildId: string | null;
  applicationId: string | null;
  permissionRequestsEnabled: boolean;
  messageOptimizationEnabled: boolean;
  forumMode?: boolean;
}

export interface SubsidiaryBotHandle {
  stop(): Promise<void>;
}

export interface SubsidiaryBotStartDeps {
  resolveConfig: () => SubsidiaryBotEnv;
  onRuntimeState?: (state: { running: boolean; status: string; error?: string }) => void;
  subsidiary: {
    id: string;
    intakeChannelId: string | null;
    process: (userId: string, userLabel: string, instruction: string) => Promise<{ replyText: string }>;
    isLocked: (userId: string) => boolean;
  };
}

export type SubsidiaryBotStarter = (
  deps: BaseDiscordDeps & SubsidiaryBotStartDeps,
) => Promise<SubsidiaryBotHandle | null>;

export interface SubsidiaryManagerDeps {
  subsidiaryRepo: SubsidiaryRepo;
  harnessRepo: HarnessRulesRepo;
  delegationRepo: DelegationRepo;
  delegationService: DelegationService;
  /**
   * 本社 Discord 接続設定を live 解決する。 子会社 Bot は **本社と同じ application_id /
   * bot token** を使い (同一 Bot を複数 guild に招待する形)、 guild_id だけ子会社固有にする。
   * spec/feature/subsidiary-delegation.md §1/§3.1。
   */
  headOfficeDiscord: () => SubsidiaryBotEnv;
  runClaude: RunClaudeFn;
  /** 子会社の日次トークン予算トラッカー (ゲートが受付前に超過判定する)。 */
  budgetTracker: SubsidiaryBudgetTracker;
  /** 子会社 Discord bot のベース deps を live 解決する (本社 bot と同じ共有 repo 群)。 */
  baseDiscordDeps: () => BaseDiscordDeps;
  /** Bot starter port. Composition roots provide the concrete chat adapter. */
  startBot: SubsidiaryBotStarter;
}

export interface SubsidiaryStartResult {
  ok: boolean;
  status: "started" | "already_running" | "disabled" | "unsupported_platform" | "missing_config" | "no_bot" | "error";
  error?: string;
}

export class SubsidiaryBotManager {
  private readonly handles = new Map<string, SubsidiaryBotHandle>();
  private readonly starts = new Map<string, Promise<SubsidiaryStartResult>>();
  private readonly restartTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: SubsidiaryManagerDeps) {}

  /**
   * 依頼 1 件をガード→記録→delegation まで通す処理系を作る (窓口の種別に依らず共通)。
   * 子会社 Bot は自分の start() で、 本社内 desk は本社 Bot の配線 (bootstrap) から使う。
   */
  processorFor(id: string): {
    process: (userId: string, userLabel: string, instruction: string) => Promise<{ replyText: string }>;
    isLocked: (userId: string) => boolean;
  } {
    const process = async (userId: string, userLabel: string, instruction: string): Promise<{ replyText: string }> => {
      const row = this.deps.subsidiaryRepo.find(id);
      if (!row) return { replyText: "⚠️ 窓口の設定が見つかりません。" };
      const result = await processSubsidiaryRequest(
        {
          subsidiaryRepo: this.deps.subsidiaryRepo,
          harnessRepo: this.deps.harnessRepo,
          delegationRepo: this.deps.delegationRepo,
          delegationService: this.deps.delegationService,
          runClaude: this.deps.runClaude,
          budget: this.deps.budgetTracker,
          log: { info: (m) => log.info(m), warn: (m) => log.warn(m) },
        },
        { subsidiary: row, platform: "discord", userId, userLabel, instruction },
      );
      return { replyText: result.replyText };
    };
    return {
      process,
      isLocked: (userId: string) => this.deps.subsidiaryRepo.isLocked(id, "discord", userId),
    };
  }

  /** 単一の子会社 Bot を起動する。 既に動いていれば already_running。 */
  async start(id: string): Promise<SubsidiaryStartResult> {
    this.clearRestart(id);
    const activeStart = this.starts.get(id);
    if (activeStart) return activeStart;
    const pending = this.startOnce(id);
    this.starts.set(id, pending);
    try {
      return await pending;
    } finally {
      if (this.starts.get(id) === pending) this.starts.delete(id);
    }
  }

  private async startOnce(id: string): Promise<SubsidiaryStartResult> {
    if (this.handles.has(id)) return { ok: true, status: "already_running" };
    const sub = this.deps.subsidiaryRepo.find(id);
    if (!sub) return { ok: false, status: "error", error: "subsidiary not found" };
    if (!sub.enabled) return { ok: true, status: "disabled" };

    // 本社内 desk は専用 Bot を持たない (本社 Bot が受付チャンネルを見る)。 起動要求は
    // 無言で成功扱いにせず、 「Bot は無い」 と明示して返す (無言フォールバック禁止)。
    if (sub.mode === "desk") {
      return { ok: false, status: "no_bot", error: "本社内窓口 (desk) は専用 Bot を持ちません (本社 Bot が受付します)" };
    }

    if (sub.platform !== "discord") {
      // Slack 子会社は Discord と同型 (per-channel 疑似カテゴリ) で計画中。 現状は明示的に
      // 未配線を返す (無言フォールバック禁止 RULE_CODE §7.1)。
      log.warn(`subsidiary ${sub.name}: platform=${sub.platform} はまだ未配線 (discord のみ稼働可)`);
      return { ok: false, status: "unsupported_platform", error: `platform '${sub.platform}' はまだ Bot 未配線` };
    }

    // 子会社 Bot は本社と同じ application_id / bot token を使う (同一 Bot を別 guild に招待)。
    // よって個別 token は不要 — 本社 token 未設定 / guild_id 未設定だけが missing_config。
    const head = this.deps.headOfficeDiscord();
    if (!head.token) {
      return { ok: false, status: "missing_config", error: "本社 Discord bot token が未設定 (子会社は本社と同じ token を使う)" };
    }
    if (!sub.guild_id) {
      return { ok: false, status: "missing_config", error: "guild_id が未設定 (出張先 Discord サーバの guild id)" };
    }

    const resolveConfig = (): SubsidiaryBotEnv => {
      const h = this.deps.headOfficeDiscord();
      const row = this.deps.subsidiaryRepo.find(id);
      return {
        enabled: true,
        token: h.token,                  // 本社と共有
        guildId: row?.guild_id ?? null,  // 出張先 guild は子会社固有
        applicationId: h.applicationId,  // 本社と共有
        permissionRequestsEnabled: h.permissionRequestsEnabled,
        messageOptimizationEnabled: h.messageOptimizationEnabled,
        forumMode: h.forumMode,
      };
    };

    const processor = this.processorFor(id);

    let handleRef: SubsidiaryBotHandle | null = null;
    const deps: BaseDiscordDeps & SubsidiaryBotStartDeps = {
      ...this.deps.baseDiscordDeps(),
      resolveConfig,
      onRuntimeState: (state) => {
        if (state.running) return;
        // manual stop は呼び出し元が handle を除去する。Gateway 障害では共有 Client 上の
        // 全 logical runtime が停止するため、各子会社も独立して再取得する。
        if (handleRef && this.handles.get(id) === handleRef) this.handles.delete(id);
        if (state.status !== "stopped" && state.status !== "disabled") {
          this.scheduleRestart(id, state.status, state.error);
        }
      },
      subsidiary: {
        id: sub.id,
        intakeChannelId: sub.channel_id,
        process: processor.process,
        isLocked: processor.isLocked,
      },
    };

    try {
      const handle = await this.deps.startBot(deps);
      if (!handle) return { ok: true, status: "disabled" };
      handleRef = handle;
      this.handles.set(id, handle);
      log.info(`subsidiary bot started: ${sub.name} (${id})`);
      return { ok: true, status: "started" };
    } catch (e) {
      return { ok: false, status: "error", error: (e as Error).message };
    }
  }

  async stop(id: string): Promise<{ ok: boolean; status: "stopped" | "already_stopped" | "error"; error?: string }> {
    this.clearRestart(id);
    const activeStart = this.starts.get(id);
    if (activeStart) {
      // start() normally converts adapter failures into an error result. Keep
      // manual stop authoritative even if an unexpected dependency throws.
      await activeStart.catch(() => undefined);
    }
    // An unexpected runtime-state callback can schedule a restart while the
    // in-flight start is settling. A manual stop remains authoritative.
    this.clearRestart(id);
    const handle = this.handles.get(id);
    if (!handle) return { ok: true, status: "already_stopped" };
    try {
      await handle.stop();
      this.handles.delete(id);
      log.info(`subsidiary bot stopped: ${id}`);
      return { ok: true, status: "stopped" };
    } catch (e) {
      return { ok: false, status: "error", error: (e as Error).message };
    }
  }

  async restart(id: string): Promise<SubsidiaryStartResult> {
    await this.stop(id);
    return this.start(id);
  }

  /** enabled な全子会社 Bot を起動 (boot 時)。 失敗は warn してスキップ (他は止めない)。 */
  async startAll(): Promise<void> {
    // desk (本社内窓口) は Bot を持たないので対象外。
    for (const sub of this.deps.subsidiaryRepo.listEnabledBots()) {
      const r = await this.start(sub.id);
      if (!r.ok) log.warn(`subsidiary ${sub.name} start skipped: ${r.status} ${r.error ?? ""}`);
    }
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.restartTimers.keys()]) this.clearRestart(id);
    const ids = new Set([...this.handles.keys(), ...this.starts.keys()]);
    for (const id of ids) await this.stop(id);
  }

  isRunning(id: string): boolean {
    return this.handles.has(id);
  }

  runningIds(): string[] {
    return [...this.handles.keys()];
  }

  private scheduleRestart(id: string, status: string, error?: string): void {
    if (this.restartTimers.has(id)) return;
    log.warn(`subsidiary bot stopped unexpectedly: ${id} status=${status} error=${error ?? "-"}; restart scheduled`);
    const timer = setTimeout(() => {
      this.restartTimers.delete(id);
      if (!this.deps.subsidiaryRepo.find(id)?.enabled || this.handles.has(id)) return;
      void this.start(id).then((result) => {
        if (!result.ok) log.warn(`subsidiary bot restart failed: ${id} ${result.status} ${result.error ?? ""}`);
      });
    }, 5_000);
    timer.unref?.();
    this.restartTimers.set(id, timer);
  }

  private clearRestart(id: string): void {
    const timer = this.restartTimers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.restartTimers.delete(id);
  }
}
