/**
 * 論理会話の受付と実行セッション交代 (application use case)。
 *
 * 判断は純関数 (input-intent / handoff-machine / handoff-package) に任せ、ここは手順と
 * 保存順を持つ。 外部副作用 (inject・後継の起動・旧担当の終了要求) は必ず状態を保存して
 * から行う。 送った結果が分からない副作用は「不明」として残し、無条件に再送しない。
 *
 * @implements spec/feature/astra-with-sidecar.md §会話と実行の寿命 / §不変条件と復旧
 */

import { randomUUID } from "node:crypto";
import { classifyConversationInput } from "./input-intent.js";
import {
  canReturnToPredecessor,
  describeHandoffBlockers,
  evaluateHandoffBlockers,
  nextHandoffState,
  type HandoffBlockerFacts,
  type HandoffEvent,
  type HandoffState,
} from "./handoff-machine.js";
import { packageHoldReasons, parseHandoffPackage, renderHandoffBrief, type HandoffPackage } from "./handoff-package.js";
import {
  buildConversationId,
  type ConversationHandoffRow,
  type ConversationInputRow,
  type ConversationRepo,
  type ConversationRow,
} from "./repo.js";

/** 1 入力の上限。 これを超える入力は保存せず、分割を求める。 */
export const MAX_CONVERSATION_INPUT_CHARS = 16_000;
/** 交代待ちで保持できる入力数の上限。 超えたら受付を断り、表示する。 */
export const MAX_HELD_INPUTS = 50;
/** 旧担当が引継ぎを保存するまでの期限。 過ぎたら旧担当へ戻す。 */
export const HANDOFF_PACKAGE_TIMEOUT_MS = 15 * 60_000;
/** 後継起動の結果を照合できるまで待つ期限。 */
export const SUCCESSOR_START_TIMEOUT_MS = 10 * 60_000;

export type DeliveryOutcome = "delivered" | "uncertain" | "failed";

export interface SuccessorRunFacts {
  runId: string;
  status: string;
  childSessionId: string | null;
}

export interface ConversationServicePorts {
  repo: ConversationRepo;
  now: () => number;
  /** セッションが Astra With Sidecar の親か (会話を持つ対象か)。 */
  isSidecarParent: (sessionId: string) => boolean;
  /** セッションが稼働中か。 不明は null。 */
  sessionActive: (sessionId: string) => boolean | null;
  blockerFacts: (input: { sessionId: string; conversationId: string }) => Omit<HandoffBlockerFacts, "uncertainInputs">;
  /** セッションへ入力を渡す。 送信の成否が分からない場合は uncertain を返す。 */
  deliver: (input: { sessionId: string; text: string; source: string; authorLabel: string | null }) => Promise<DeliveryOutcome>;
  /** 後継を起動する。 例外は結果不明として扱い、run の照合に回す。 */
  startSuccessor: (input: {
    handoff: ConversationHandoffRow;
    conversation: ConversationRow;
    brief: string;
  }) => Promise<{ ok: true; runId: string } | { ok: false; error: string }>;
  /** 起動済み run の照合 (結果不明の起動を二重に行わないため)。 */
  findSuccessorRun: (handoff: ConversationHandoffRow) => SuccessorRunFacts | null;
  /** 旧担当に終了を要求する (ターンが静かになってから終わる)。 */
  requestSessionEnd: (sessionId: string) => void;
}

export type IngressDecision =
  | { action: "passthrough" }
  | { action: "duplicate" }
  | { action: "reject"; reply: string }
  | { action: "held"; reply: string }
  | { action: "handoff_started"; reply: string }
  | { action: "inject"; sessionId: string; inputId: number; reply?: string };

export interface ConversationIngressInput {
  platform: string;
  scope: string;
  guildId: string;
  threadId: string;
  messageId: string;
  authorId: string;
  authorLabel: string | null;
  text: string;
  /** スレッドに今結び付いているセッション (会話が無い時の初期担当)。 */
  boundSessionId: string;
  /** この人間が交代・停止を指示できるか (セッション終了と同じ権限)。 */
  canControlSession: boolean;
}

export class ConversationService {
  constructor(private readonly ports: ConversationServicePorts) {}

  private get repo(): ConversationRepo {
    return this.ports.repo;
  }

  /** Discord などの人間入力を受け付け、配達先または保留を決める。 */
  accept(input: ConversationIngressInput): IngressDecision {
    const now = this.ports.now();
    const conversation = this.resolveConversation(input, now);
    if (!conversation) return { action: "passthrough" };
    if (input.text.length > MAX_CONVERSATION_INPUT_CHARS) {
      return { action: "reject", reply: `入力が長すぎます (${MAX_CONVERSATION_INPUT_CHARS} 文字まで)。分けて送ってください。` };
    }
    const intent = classifyConversationInput(input.text);
    const inserted = this.repo.insertInput({
      conversationId: conversation.conversation_id,
      platformMessageId: input.messageId,
      authorId: input.authorId,
      authorLabel: input.authorLabel,
      intent: intent.kind,
      text: input.text,
      generation: conversation.generation,
      state: "received",
      targetSessionId: conversation.owner_session_id,
      handoffId: null,
      now,
    });
    if (inserted.duplicate) return { action: "duplicate" };
    const row = inserted.row;

    if (conversation.state === "handing_off" && conversation.active_handoff_id) {
      const handoff = this.repo.findHandoff(conversation.active_handoff_id);
      if (handoff && (intent.kind === "stop" || intent.kind === "cancel") && input.canControlSession
        && canReturnToPredecessor(handoff.state)) {
        this.returnToPredecessor(handoff, intent.kind === "stop" ? "stopped_by_human" : "cancelled_by_human", "abort");
        return this.deliverNow(row, conversation.owner_session_id, "交代を中断し、前の担当へ戻しました。");
      }
      if (this.repo.countInputs(conversation.conversation_id, ["held"]) >= MAX_HELD_INPUTS) {
        this.repo.transitionInput(row.id, ["received"], "rejected", { error: "held_limit" }, now);
        return { action: "reject", reply: `交代中の保留が上限 (${MAX_HELD_INPUTS} 件) に達しました。交代の完了を待ってから送ってください。` };
      }
      this.repo.transitionInput(row.id, ["received"], "held", { handoffId: conversation.active_handoff_id, targetSessionId: null }, now);
      return { action: "held", reply: "実行セッションの交代中です。この投稿は保存し、後継セッションへ順に渡します。" };
    }

    if (intent.kind === "next_work") {
      if (!input.canControlSession) {
        return this.deliverNow(row, conversation.owner_session_id, "交代を指示できる権限がないため、通常の依頼として現在の担当へ渡しました。");
      }
      return this.startHandoff(conversation, row, intent.instruction, now);
    }
    return this.deliverNow(row, conversation.owner_session_id);
  }

  /** ingress が inject した結果を記録する。 不明は不明のまま残す (自動再送しない)。 */
  reportDelivery(inputId: number, outcome: DeliveryOutcome, error: string | null): ConversationInputRow | null {
    const state = outcome === "delivered" ? "delivered" : outcome === "uncertain" ? "uncertain" : "failed";
    return this.repo.transitionInput(inputId, ["delivering"], state, { error: outcome === "delivered" ? null : error }, this.ports.now());
  }

  /** 旧担当が引継ぎを保存する。 人間待ち・結果不明の外部操作が残るなら交代しない。 */
  async savePackage(handoffId: string, sessionId: string, value: unknown): Promise<
    | { ok: true; handoff: ConversationHandoffRow }
    | { ok: false; error: string; issues?: string[]; holds?: string[] }
  > {
    const handoff = this.repo.findHandoff(handoffId);
    if (!handoff) return { ok: false, error: "handoff_not_found" };
    if (handoff.from_session_id !== sessionId) return { ok: false, error: "not_handoff_owner" };
    if (handoff.state !== "handoff_pending") return { ok: false, error: `handoff_not_pending:${handoff.state}` };
    const parsed = parseHandoffPackage(value);
    if (!parsed.ok) return { ok: false, error: "invalid_package", issues: parsed.issues };
    const holds = packageHoldReasons(parsed.package);
    if (holds.length) {
      this.returnToPredecessor(handoff, `package_holds: ${holds.join(" / ")}`, "abort");
      return { ok: false, error: "handoff_held", holds };
    }
    const now = this.ports.now();
    const saved = this.repo.transitionHandoff(handoff.id, "handoff_pending", this.transition("handoff_pending", "package_saved"), {
      package_json: JSON.stringify(parsed.package),
      package_saved_at: now,
    }, now);
    if (!saved) return { ok: false, error: "handoff_state_changed" };
    await this.advance(saved.id);
    return { ok: true, handoff: this.repo.findHandoff(saved.id)! };
  }

  /**
   * 交代を 1 段ずつ進める。 reconciler と各イベントから何度呼ばれても、保存済みの
   * 状態から決まる次の一手だけを行う (冪等)。
   */
  async advance(handoffId: string): Promise<ConversationHandoffRow | null> {
    for (let step = 0; step < 6; step += 1) {
      const handoff = this.repo.findHandoff(handoffId);
      if (!handoff) return null;
      const moved = await this.advanceOnce(handoff);
      if (!moved) return this.repo.findHandoff(handoffId);
    }
    return this.repo.findHandoff(handoffId);
  }

  private async advanceOnce(handoff: ConversationHandoffRow): Promise<boolean> {
    const now = this.ports.now();
    switch (handoff.state) {
      case "handoff_pending":
        if (now - handoff.created_at > HANDOFF_PACKAGE_TIMEOUT_MS) {
          this.returnToPredecessor(handoff, "package_timeout", "abort");
          return true;
        }
        return false;
      case "handoff_saved":
        return this.requestSuccessor(handoff, now);
      case "successor_requested":
        return this.checkSuccessor(handoff, now);
      case "successor_ready":
        return this.switchRouting(handoff, now);
      case "routing_switched":
        return this.drainPredecessor(handoff, now);
      default:
        return false;
    }
  }

  private async requestSuccessor(handoff: ConversationHandoffRow, now: number): Promise<boolean> {
    const conversation = this.repo.findConversation(handoff.conversation_id);
    if (!conversation) return false;
    // 起動の前に successor_requested を保存する。 起動応答を失っても、この状態から
    // run を照合するため二重起動しない。
    const requested = this.repo.transitionHandoff(handoff.id, "handoff_saved",
      this.transition("handoff_saved", "successor_requested"), {}, now);
    if (!requested) return false;
    const pkg = JSON.parse(requested.package_json ?? "null") as HandoffPackage;
    const brief = renderHandoffBrief({
      conversationId: conversation.conversation_id,
      handoffId: requested.id,
      generation: conversation.generation + 1,
      pkg,
      nextInstruction: requested.next_instruction ?? "",
    });
    let result: Awaited<ReturnType<ConversationServicePorts["startSuccessor"]>>;
    try {
      result = await this.ports.startSuccessor({ handoff: requested, conversation, brief });
    } catch (error) {
      this.repo.transitionHandoff(requested.id, "successor_requested", "successor_requested", {
        error: `start_uncertain: ${(error as Error).message}`.slice(0, 500),
      }, this.ports.now());
      return false;
    }
    if (!result.ok) {
      this.returnToPredecessor(requested, `successor_start_failed: ${result.error}`, "fail");
      return true;
    }
    this.repo.transitionHandoff(requested.id, "successor_requested", "successor_requested", {
      successor_run_id: result.runId,
      error: null,
    }, this.ports.now());
    return true;
  }

  private checkSuccessor(handoff: ConversationHandoffRow, now: number): boolean {
    const run = this.ports.findSuccessorRun(handoff);
    if (!run) {
      if (now - handoff.updated_at > SUCCESSOR_START_TIMEOUT_MS) {
        this.returnToPredecessor(handoff, "successor_not_found", "fail");
        return true;
      }
      return false;
    }
    if (!handoff.successor_run_id) {
      this.repo.transitionHandoff(handoff.id, "successor_requested", "successor_requested", { successor_run_id: run.runId, error: null }, now);
    }
    if (run.status === "failed" || run.status === "spawn_failed") {
      this.returnToPredecessor(handoff, `successor_run_${run.status}`, "fail");
      return true;
    }
    if (!run.childSessionId || this.ports.sessionActive(run.childSessionId) !== true) {
      if (now - handoff.updated_at > SUCCESSOR_START_TIMEOUT_MS && !run.childSessionId) {
        this.returnToPredecessor(handoff, "successor_session_not_started", "fail");
        return true;
      }
      return false;
    }
    return this.repo.transitionHandoff(handoff.id, "successor_requested",
      this.transition("successor_requested", "successor_ready"), { to_session_id: run.childSessionId, successor_run_id: run.runId }, now) !== null;
  }

  private async switchRouting(handoff: ConversationHandoffRow, now: number): Promise<boolean> {
    const conversation = this.repo.findConversation(handoff.conversation_id);
    if (!conversation || !handoff.to_session_id) return false;
    if (conversation.active_handoff_id !== handoff.id) {
      this.repo.transitionHandoff(handoff.id, "successor_ready", "failed", { error: "conversation_moved_on" }, now);
      return true;
    }
    const switched = this.repo.transaction(() => {
      const updated = this.repo.compareAndSetConversation(conversation.conversation_id, conversation.version, {
        owner_session_id: handoff.to_session_id!,
        generation: conversation.generation + 1,
        state: "active",
        active_handoff_id: null,
      }, now);
      if (!updated) return null;
      return this.repo.transitionHandoff(handoff.id, "successor_ready",
        this.transition("successor_ready", "routing_switched"), { switched_at: now }, now);
    });
    if (!switched) return false;
    // きっかけの「次の作業」は引継ぎ本文に含めて渡したので、配達済みとして閉じる。
    if (switched.trigger_input_id != null) {
      this.repo.transitionInput(switched.trigger_input_id, ["held"], "delivering", { targetSessionId: switched.to_session_id }, now);
      this.repo.transitionInput(switched.trigger_input_id, ["delivering"], "delivered", { error: null }, now);
    }
    await this.deliverHeld(switched.conversation_id, switched.id, switched.to_session_id!);
    this.ports.requestSessionEnd(switched.from_session_id);
    return true;
  }

  private drainPredecessor(handoff: ConversationHandoffRow, now: number): boolean {
    if (this.ports.sessionActive(handoff.from_session_id) === true) return false;
    return this.repo.transitionHandoff(handoff.id, "routing_switched",
      this.transition("routing_switched", "predecessor_drained"), { drained_at: now }, now) !== null;
  }

  private startHandoff(conversation: ConversationRow, row: ConversationInputRow, instruction: string, now: number): IngressDecision {
    const facts = this.ports.blockerFacts({ sessionId: conversation.owner_session_id, conversationId: conversation.conversation_id });
    const blockers = evaluateHandoffBlockers({
      ...facts,
      uncertainInputs: this.repo.countInputs(conversation.conversation_id, ["uncertain"]),
    });
    if (blockers.length) {
      return this.deliverNow(row, conversation.owner_session_id,
        `交代を保留しました (${describeHandoffBlockers(blockers)})。現在の担当へ依頼として渡しています。解消後にもう一度「次の作業」と送ってください。`);
    }
    const handoffId = `hof_${randomUUID()}`;
    const started = this.repo.transaction(() => {
      const moved = this.repo.compareAndSetConversation(conversation.conversation_id, conversation.version, {
        state: "handing_off",
        active_handoff_id: handoffId,
      }, now);
      if (!moved) return null;
      const handoff = this.repo.createHandoff({
        id: handoffId,
        conversationId: conversation.conversation_id,
        fromSessionId: conversation.owner_session_id,
        fromGeneration: conversation.generation,
        triggerInputId: row.id,
        nextInstruction: instruction,
        correlationId: `handoff:${handoffId}`,
        now,
      });
      this.repo.transitionInput(row.id, ["received"], "held", { handoffId, targetSessionId: null }, now);
      return handoff;
    });
    if (!started) {
      return this.deliverNow(row, conversation.owner_session_id, "会話の状態が同時に変わったため、交代せず現在の担当へ渡しました。");
    }
    void this.ports.deliver({
      sessionId: conversation.owner_session_id,
      text: buildPackageRequest(started),
      source: `conversation:${conversation.conversation_id}:handoff:${handoffId}`,
      authorLabel: null,
    }).catch(() => "uncertain" as const);
    return {
      action: "handoff_started",
      reply: "次の作業へ移るため、現在の担当に引継ぎの保存を依頼しました。保存後に新しい実行セッションへ切り替えます。この間の投稿は保存して後継へ渡します。",
    };
  }

  private deliverNow(row: ConversationInputRow, sessionId: string, reply?: string): IngressDecision {
    const moved = this.repo.transitionInput(row.id, ["received", "held"], "delivering", { targetSessionId: sessionId }, this.ports.now());
    if (!moved) return { action: "duplicate" };
    return reply ? { action: "inject", sessionId, inputId: row.id, reply } : { action: "inject", sessionId, inputId: row.id };
  }

  /**
   * 交代を中断して旧担当へ戻す。 routing_switched 以降は呼ばない (停止した担当を
   * 無条件で復活させない)。 保留していた入力は元の順序で旧担当へ渡す。
   */
  private returnToPredecessor(handoff: ConversationHandoffRow, reason: string, event: Extract<HandoffEvent, "abort" | "fail">): void {
    const now = this.ports.now();
    const target = nextHandoffState(handoff.state, event);
    if (!target) return;
    const closed = this.repo.transaction(() => {
      const done = this.repo.transitionHandoff(handoff.id, handoff.state, target, { error: reason.slice(0, 500) }, now);
      if (!done) return null;
      const conversation = this.repo.findConversation(handoff.conversation_id);
      if (conversation && conversation.active_handoff_id === handoff.id) {
        this.repo.compareAndSetConversation(conversation.conversation_id, conversation.version, {
          state: "active",
          active_handoff_id: null,
        }, now);
      }
      return done;
    });
    if (!closed) return;
    void this.deliverHeld(handoff.conversation_id, handoff.id, handoff.from_session_id, reason);
  }

  private async deliverHeld(conversationId: string, handoffId: string, sessionId: string, abortReason?: string): Promise<void> {
    const held = this.repo.listInputs(conversationId, ["held"]).filter((input) => input.handoff_id === handoffId);
    if (abortReason) {
      await this.ports.deliver({
        sessionId,
        text: `[conversation] 実行セッションの交代を中断しました (${abortReason})。引き続きこのセッションが担当です。保留していた投稿 ${held.length} 件を順に渡します。`,
        source: `conversation:${conversationId}:handoff:${handoffId}:aborted`,
        authorLabel: null,
      }).catch(() => "uncertain" as const);
    }
    for (const input of held) {
      const moved = this.repo.transitionInput(input.id, ["held"], "delivering", { targetSessionId: sessionId }, this.ports.now());
      if (!moved) continue;
      let outcome: DeliveryOutcome;
      try {
        outcome = await this.ports.deliver({
          sessionId,
          text: input.text ?? "",
          source: `discord:${input.author_id}:${threadOf(conversationId)}:${input.platform_message_id}`,
          authorLabel: input.author_label,
        });
      } catch {
        outcome = "uncertain";
      }
      this.reportDelivery(input.id, outcome, outcome === "delivered" ? null : "held_delivery");
    }
  }

  private resolveConversation(input: ConversationIngressInput, now: number): ConversationRow | null {
    const existing = this.repo.findConversation(buildConversationId(input));
    if (existing) return existing;
    if (!this.ports.isSidecarParent(input.boundSessionId)) return null;
    return this.repo.ensureConversation({
      platform: input.platform,
      scope: input.scope,
      guildId: input.guildId,
      threadId: input.threadId,
      ownerSessionId: input.boundSessionId,
      now,
    });
  }

  private transition(from: HandoffState, event: HandoffEvent): HandoffState {
    const next = nextHandoffState(from, event);
    if (!next) throw new Error(`invalid handoff transition ${from} --${event}->`);
    return next;
  }
}

function threadOf(conversationId: string): string {
  return conversationId.split(":").at(-1) ?? conversationId;
}

function buildPackageRequest(handoff: ConversationHandoffRow): string {
  return [
    `[conversation] 人間が「次の作業」へ移るよう指示しました (handoff: ${handoff.id})。`,
    "新しい作業には着手せず、今の作業の引継ぎを保存してください。保存前に clear / compact / 終了はしないでください。",
    `POST /v1/delegation/sidecar/handoffs/${handoff.id}/package に { "session_id": "<このセッション ID>", "package": { ... } } を送ります。`,
    "package の項目: summary, decisions[{decision, reason}], repo_path, branch, outputs[], remaining[], authorization_scope,",
    "human_waits[], external_operations[{kind, correlation_id, state: confirmed|uncertain|not_started}], task_references[], references[]。",
    "人間待ちや結果不明の外部操作がある場合は正直に書いてください。その場合は交代せず、このセッションが担当を続けます。",
    `期限は ${HANDOFF_PACKAGE_TIMEOUT_MS / 60_000} 分です。期限を過ぎると交代は中断されます。`,
  ].join("\n");
}
