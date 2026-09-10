// @spec ハーネス信頼性の実装境界
import type { SessionsRepo } from "../../db/sessions-repo.js";
import type { SessionMessagesRepo } from "../../db/session-messages-repo.js";
import { redactSecrets } from "../../shared/redact-secrets.js";
import { buildCheckpoint, checkpointContext } from "./checkpoint.js";
import { classifyMcpOutcome, injectionSignals, mcpServerKey } from "./mcp-observation.js";
import { sampleDecision } from "./guidance.js";
import type { PromptSample } from "./state.js";
import type { ReliabilityStore } from "./store.js";
import { workflowGuidance, workflowContext } from "./workflow-guidance.js";
import { observeToolFollowup } from "./tool-followup.js";

export interface ReliabilityHookInput {
  event: "pre-compact" | "post-compact" | "resume-compact" | "tool-result" | "prompt";
  event_id: string;
  trigger?: string;
  tool?: string;
  failed?: boolean;
  status?: number;
  code?: string;
  message?: string;
  prompt?: string;
}

export class ReliabilityHookService {
  constructor(private readonly deps: {
    sessions: SessionsRepo; messages: SessionMessagesRepo; store: ReliabilityStore;
    pendingQuestions: (sessionId: string) => unknown;
    acceptanceManifest: (cwd: string) => unknown;
    notify: (sessionId: string, text: string) => number;
    assess: (sessionId: string, sampleId: string) => void;
    now: () => number; random: () => number;
  }) {}

  handle(id: string, input: ReliabilityHookInput): { ok: true; context?: string; checkpoint_id?: string } {
    const session = this.deps.sessions.findSession(id);
    if (!session) throw new Error("session not found");
    const metadata = session.metadata ? JSON.parse(session.metadata) as Record<string, unknown> : {};
    const at = this.deps.now();
    if (input.event === "pre-compact") {
      const checkpoint = buildCheckpoint({ session, metadata, id: input.event_id, at, trigger: input.trigger ?? "unknown",
        pendingQuestions: this.deps.pendingQuestions(id),
        recentWork: {
          augur_contract: this.deps.acceptanceManifest(session.repo_path),
          messages: this.deps.messages.list(id, { limit: 40 }).filter((message) => ["delegation", "question"].includes(message.author_type)
            || (message.author_type === "user" && !!message.author_platform))
            .slice(-10).map((message) => ({ id: message.id, type: message.author_type, content: redactSecrets(message.content).slice(0, 1500) })),
        },
      });
      const state = this.deps.store.update(id, (state) => {
        if (!state.checkpoints.some((item) => item.id === checkpoint.id)) state.checkpoints = [...state.checkpoints, checkpoint].slice(-3);
        state.observations.compaction = { at, status: "saved", reason: "Native PreCompact checkpoint persisted; compaction result not yet observed" };
      });
      if (!state.checkpoints.some((item) => item.id === checkpoint.id)) throw new Error("checkpoint readback failed");
      return { ok: true, checkpoint_id: checkpoint.id };
    }
    if (input.event === "post-compact" || input.event === "resume-compact") {
      if (input.trigger === "clear") {
        const recovery = metadata.compaction_recovery as { state?: string; handoff?: string } | undefined;
        if (!recovery?.handoff || !["clear_requested", "reinject_requested"].includes(recovery.state ?? "")) return { ok: true };
        this.deps.store.update(id, (state) => { state.checkpoints = [...state.checkpoints, {
          id: input.event_id, at, trigger: "manual-clear", text: redactSecrets(recovery.handoff!).slice(0, 48000),
        }].slice(-3); });
        this.deps.sessions.updateMetadata(id, (current) => {
          const { compaction_recovery: _recovery, ...rest } = current;
          return { ...rest, last_compaction_at: at };
        });
      }
      const state = this.deps.store.update(id, (state) => {
        const checkpoint = state.checkpoints.at(-1);
        if (checkpoint && input.event === "resume-compact") checkpoint.restored_at = at;
        state.observations.compaction = { at, status: checkpoint ? input.event === "resume-compact" ? "context_returned" : "compacted" : "missing_checkpoint",
          reason: checkpoint ? "Native compaction hook observed; context consumption is not acknowledged" : "Compaction observed without a saved PreCompact record" };
      });
      const checkpoint = state.checkpoints.at(-1);
      return { ok: true, ...(checkpoint && input.event === "resume-compact" ? {
        context: checkpointContext(checkpoint, `/v1/harness/reliability/${encodeURIComponent(id)}/checkpoint`), checkpoint_id: checkpoint.id,
      } : {}) };
    }
    if (input.event === "tool-result") {
      let followup = "";
      this.deps.store.update(id, (state) => { followup = observeToolFollowup(state, input, at); });
      const server = mcpServerKey(input.tool ?? "");
      if (!server) return { ok: true, context: followup };
      const outcome = classifyMcpOutcome({ tool: input.tool!, failed: input.failed === true, status: input.status, code: input.code, message: input.message ?? "" });
      const signals = injectionSignals(input.message ?? "");
      let alert = "";
      this.deps.store.update(id, (state) => {
        // Track per tool: success on a public tool must not clear another tool's auth failure.
        const key = input.tool!;
        const previous = state.mcp[key];
        if (outcome === "auth_required" && previous?.status !== "auth_required") alert = `MCP ${server}: 認証が必要です。接続設定から再認証してください。`;
        if (outcome === "success" && previous?.status === "auth_required") alert = `MCP ${server}: 同じツールの成功を観測しました。他のツールの認証状態は未確認です。`;
        state.mcp[key] = { at, status: previous?.status === "auth_required" && outcome !== "success" ? "auth_required" : outcome,
          reason: `Last tool outcome: ${outcome}; no active authentication probe` };
        state.mcp = Object.fromEntries(Object.entries(state.mcp).sort((a, b) => b[1].at - a[1].at).slice(0, 50));
        const pendingAuth = Object.values(state.mcp).filter((item) => item.status === "auth_required").length;
        state.observations.mcp_auth = { at, status: pendingAuth ? "auth_required" : outcome,
          reason: `${server}: ${outcome}; tools still requiring authentication: ${pendingAuth}` };
        const signal = signals.join(",");
        if (signals.length && at - (state.observations.mcp_injection_notice?.at ?? 0) >= 600_000) {
          alert += `\nMCP ${server}: 応答に出所偽装または秘密送信の誘導候補があります。助言のみで、claimを含む通常指示は遮断しません。`;
          state.observations.mcp_injection_notice = { at, status: "requested", reason: signal };
        }
        state.observations.mcp_injection = { at, status: signals.length ? "advisory" : "no_signal", reason: signal || "No configured signal; not a safety guarantee" };
      });
      if (alert) {
        let delivered = false;
        try { this.deps.notify(id, alert.trim()); delivered = true; } catch { /* Record failed delivery separately from the tool outcome. */ }
        this.deps.store.update(id, (state) => { state.observations.notification = { at, status: delivered ? "queued_delivery_unconfirmed" : "failed",
          reason: delivered ? "SYSTEM notification queued; Discord delivery unconfirmed" : "Notification unavailable; inspect MCP status here" }; });
      }
      return { ok: true, context: [followup, alert.trim()].filter(Boolean).join("\n") };
    }
    const prompt = input.prompt ?? "";
    // Compare with server-owned human ingress; never trust a body claiming 'human'.
    const messages = this.deps.messages.list(id, { limit: 60 });
    const human = messages.findLast((message) => message.author_type === "user"
      && ["discord", "slack", "web"].includes(message.author_platform ?? "")
      && at - message.ts * 1000 < 120_000 && message.content.trim() === prompt.trim());
    if (!human) {
      this.deps.store.update(id, (state) => { state.observations.prompt_source = { at, status: "unknown_or_automatic", reason: "No matching server-owned human ingress; not sampled" }; });
      return { ok: true };
    }
    let sample: PromptSample | undefined;
    let context = "";
    const routes = workflowGuidance(prompt);
    const routeKey = routes.map((route) => route.kind).join(",");
    this.deps.store.update(id, (state) => {
      const previous = state.observations.workflow_guidance;
      if (routes.length && (previous?.reason !== routeKey || at - previous.at >= 900_000)) {
        context = workflowContext(routes);
        state.observations.workflow_guidance = { at, status: "recommended", reason: routeKey };
      }
    });
    const humanEvent = this.deps.sessions.recentEvents(id, 100).find((event) => {
      if (event.kind !== "inject" || Math.abs(event.ts - human.ts) > 5) return false;
      try { return JSON.parse(event.payload).text?.trim() === prompt.trim(); } catch { return false; }
    });
    const source = humanEvent ? JSON.parse(humanEvent.payload).source : null;
    // Current Discord ingress records author:channel:message. Older/unknown forms stay session-local.
    const actor = typeof source === "string" ? /^discord:(\d+):\d+:\d+$/.exec(source) : null;
    this.deps.store.update(id, (state) => {
      const sampleId = `human:${human.id}`;
      if (state.observations.prompt_source?.reason === sampleId || state.samples.some((item) => item.id === sampleId)) return;
      state.prompt_count++;
      state.observations.prompt_source = { at, status: "human_ingress", reason: sampleId };
      const slot = Math.floor(at / 900_000);
      const selected = sampleDecision({ count: state.prompt_count, samples: state.samples.length, slot, lastSlot: state.last_sample_slot, random: this.deps.random() });
      state.last_sample_slot = Math.max(state.last_sample_slot, slot);
      if (!selected) return;
      sample = { id: sampleId, user_key: actor ? `discord:${actor[1]}` : null, user_label: human.author_label.slice(0, 80), at,
        stage: state.prompt_count === 1 ? "initial" : "middle", turn: state.prompt_count,
        elapsed_minutes: Math.max(0, (at - session.started_at * 1000) / 60_000), provider: session.provider,
        model: typeof metadata.model === "string" ? metadata.model : null, context_usage: null,
        after_compaction: state.checkpoints.some((item) => !!item.restored_at),
        prompt: redactSecrets(prompt).slice(0, 6000),
        context: redactSecrets(messages.filter((message) => message.id < human.id && (message.author_type === "assistant"
          || (message.author_type === "user" && ["discord", "slack", "web"].includes(message.author_platform ?? ""))))
          .slice(-6).map((message) => `${message.author_type}: ${message.content.slice(0, 1200)}`).join("\n")),
        status: "pending" };
      state.samples.push(sample);
    });
    if (sample) this.deps.assess(id, sample.id);
    return { ok: true, ...(context ? { context } : {}) };
  }
}
