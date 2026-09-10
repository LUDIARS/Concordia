// @spec ハーネス信頼性の実装境界
import type { RunClaudeFn } from "../../rules/claude-runner.js";
import { redactSecrets } from "../../shared/redact-secrets.js";
import { GUIDANCE_REVISION, guidancePrompt, officialGuidance } from "./guidance.js";
import type { ReliabilityStore } from "./store.js";

export class PromptAdvisor {
  constructor(private readonly deps: {
    store: ReliabilityStore;
    run: RunClaudeFn;
    notify: (sessionId: string, text: string) => number;
    now: () => number;
  }) {}

  async assess(sessionId: string, sampleId: string): Promise<void> {
    const sample = this.deps.store.read(sessionId).samples.find((item) => item.id === sampleId);
    if (!sample) return;
    let advice: string | undefined;
    if (officialGuidance(sample.provider).length) {
      try {
        const result = await this.deps.run(guidancePrompt([sample], false), { timeoutMs: 30_000 });
        if (result.ok && result.stdout.trim()) advice = redactSecrets(result.stdout.trim()).slice(0, 1800);
      } catch { /* Stored as unavailable, never a user failure. */ }
    }
    this.deps.store.update(sessionId, (state) => {
      const current = state.samples.find((item) => item.id === sampleId);
      if (!current) return;
      current.status = advice ? "assessed" : "unavailable";
      current.advice = advice;
      state.observations.guidance = { at: this.deps.now(), status: current.status,
        reason: advice ? `Official guidance ${GUIDANCE_REVISION}; advisory only` : "Classifier or applicable official guidance unavailable" };
    });
  }

  async report(sessionId: string): Promise<{ text: string; message_id: number; delivery: "unconfirmed" }> {
    const now = this.deps.now();
    let acquired = false;
    this.deps.store.update(sessionId, (state) => {
      if (state.report?.status === "publishing" || (state.report && now - state.report.at < 90_000)) return;
      if (!state.samples.length) return;
      state.report = { at: now, status: "pending" };
      acquired = true;
    });
    if (!acquired) throw new Error("No samples, a report is pending, or the 90-second report budget is exhausted");
    try {
      const samples = this.deps.store.history(sessionId, now - 30 * 24 * 60 * 60 * 1000);
      const result = await this.deps.run(guidancePrompt(samples, true), { timeoutMs: 30_000 });
      if (!result.ok || !result.stdout.trim()) throw new Error("Classifier unavailable");
      const sources = [...new Set(samples.flatMap((item) => officialGuidance(item.provider).map((source) => source.url)))];
      const text = `プロンプトアプローチ（助言）\n標本 ${samples.length} 件 / ${new Date(samples[0].at).toISOString()} ～ ${new Date(samples.at(-1)!.at).toISOString()}\n`
        + redactSecrets(result.stdout.trim()).slice(0, 1800) + `\n公式資料確認日: ${GUIDANCE_REVISION}\n${sources.join("\n")}`;
      let ownsRequest = false;
      this.deps.store.update(sessionId, (state) => {
        if (state.report?.at !== now || state.report.status !== "pending") return;
        state.report.status = "publishing";
        ownsRequest = true;
      });
      if (!ownsRequest) throw new Error("Report request was superseded");
      const messageId = this.deps.notify(sessionId, text);
      this.deps.store.update(sessionId, (state) => { state.report = { at: now, status: "queued_delivery_unconfirmed", text, message_id: messageId }; });
      return { text, message_id: messageId, delivery: "unconfirmed" };
    } catch (error) {
      this.deps.store.update(sessionId, (state) => {
        if (state.report?.at !== now) return;
        state.report = { at: now, status: state.report.status === "publishing" ? "delivery_unknown" : "failed" };
      });
      throw error;
    }
  }
}
