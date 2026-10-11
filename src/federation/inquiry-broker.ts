/**
 * 拠点間ワンショット調査の待ち合わせ (request_id → 結果)。
 *
 * - 自分が出した依頼: `wait` で結果か期限切れを待つ。 結果を返す相手は依頼時の宛先だけ受け付ける。
 * - 本社の中継: `relay` で request_id → 依頼元拠点を覚え、 宛先から結果が来たら依頼元を返す。
 *
 * 状態はプロセス内だけに持つ。 再起動で消えた依頼は依頼元の期限切れで終わる (再送しない)。
 *
 * @implements spec/feature/federation-link.md §拠点間ワンショット調査 (SPEC-FED-INQUIRY)
 */
import type { FederationInquiryResultFrame } from "./protocol.js";
import { isExpectedInquiryResponder } from "./inquiry-policy.js";

export interface InquiryOutcome {
  ok: boolean;
  output: string;
  error: string | null;
  executedBy: string;
  durationMs: number | null;
}

interface Waiter {
  target: string;
  resolve(outcome: InquiryOutcome): void;
  timer: NodeJS.Timeout;
}

interface Relay {
  origin: string;
  target: string;
  timer: NodeJS.Timeout;
}

export interface InquiryBroker {
  /** 依頼を送る前に登録し、 結果か期限切れを待つ。 同じ id の二重登録は即失敗。 */
  wait(requestId: string, target: string, timeoutMs: number): Promise<InquiryOutcome>;
  /** 本社: 拠点 → 拠点の中継を覚える。 */
  relay(requestId: string, origin: string, target: string, timeoutMs: number): void;
  /**
   * 受け取った結果を振り分ける。 `settled` = 自分の待ちを解いた、 `relay` = 依頼元へ返す、
   * `ignored` = 知らない id か宛先以外からの結果。
   */
  accept(fromParty: string, frame: FederationInquiryResultFrame): { kind: "settled" } | { kind: "relay"; origin: string } | { kind: "ignored" };
  /** 送信失敗など、 結果を待たずに終える。 */
  fail(requestId: string, error: string): void;
  /** リンク断・停止。 待ちを全て失敗で解く。 */
  failAll(error: string): void;
  pendingCount(): number;
}

export function toInquiryOutcome(frame: FederationInquiryResultFrame): InquiryOutcome {
  return {
    ok: frame.ok,
    output: frame.output ?? "",
    error: frame.error ?? null,
    executedBy: frame.executed_by,
    durationMs: frame.duration_ms ?? null,
  };
}

export function createInquiryBroker(): InquiryBroker {
  const waiters = new Map<string, Waiter>();
  const relays = new Map<string, Relay>();

  const finish = (requestId: string, outcome: InquiryOutcome): boolean => {
    const waiter = waiters.get(requestId);
    if (!waiter) return false;
    waiters.delete(requestId);
    clearTimeout(waiter.timer);
    waiter.resolve(outcome);
    return true;
  };

  return {
    wait(requestId, target, timeoutMs) {
      if (waiters.has(requestId)) {
        return Promise.resolve({ ok: false, output: "", error: "an inquiry with this id is already in flight", executedBy: target, durationMs: null });
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          finish(requestId, {
            ok: false,
            output: "",
            error: `no result within ${Math.round(timeoutMs / 1000)}s (the target may be busy, offline, or running an older Concordia)`,
            executedBy: target,
            durationMs: null,
          });
        }, timeoutMs);
        timer.unref?.();
        waiters.set(requestId, { target, resolve, timer });
      });
    },
    relay(requestId, origin, target, timeoutMs) {
      const previous = relays.get(requestId);
      if (previous) clearTimeout(previous.timer);
      const timer = setTimeout(() => relays.delete(requestId), timeoutMs);
      timer.unref?.();
      relays.set(requestId, { origin, target, timer });
    },
    accept(fromParty, frame) {
      const waiter = waiters.get(frame.request_id);
      if (waiter) {
        if (!isExpectedInquiryResponder(waiter.target, fromParty)) return { kind: "ignored" };
        finish(frame.request_id, toInquiryOutcome(frame));
        return { kind: "settled" };
      }
      const relay = relays.get(frame.request_id);
      if (relay && isExpectedInquiryResponder(relay.target, fromParty)) {
        relays.delete(frame.request_id);
        clearTimeout(relay.timer);
        return { kind: "relay", origin: relay.origin };
      }
      return { kind: "ignored" };
    },
    fail(requestId, error) {
      const waiter = waiters.get(requestId);
      if (!waiter) return;
      finish(requestId, { ok: false, output: "", error, executedBy: waiter.target, durationMs: null });
    },
    failAll(error) {
      for (const [requestId, waiter] of [...waiters]) {
        finish(requestId, { ok: false, output: "", error, executedBy: waiter.target, durationMs: null });
      }
      for (const relay of relays.values()) clearTimeout(relay.timer);
      relays.clear();
    },
    pendingCount() {
      return waiters.size;
    },
  };
}
