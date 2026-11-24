/**
 * 依頼窓口の受付・一覧の use case (spec/feature/request-desk.md)。
 * Web と Discord は同じ submit を呼ぶ (CC-V5-INV-07)。判定は desk-request-policy.ts、保存は DeskRepository。
 *
 * @implements spec/feature/request-desk.md — 受付 (CC-V5-INV-01)
 */
import {
  DESK_REQUESTER_MAX_CHARS,
  decideSubmission,
  deskBodyProblem,
  originOfRequestKey,
  type DeskProvider,
  type DeskRequest,
} from "./desk-request-policy.js";
import type { DeskRepository } from "./repository.js";

export interface SubmitDeskInput {
  requestKey: string;
  requester: string;
  provider: DeskProvider;
  body: string;
}

export type SubmitDeskOutcome =
  | { kind: "created" | "existing"; request: DeskRequest }
  | { kind: "conflict"; request: DeskRequest }
  | { kind: "invalid"; problem: string }
  | { kind: "disabled" };

export interface DeskServicePorts {
  now: () => number;
  id: () => string;
  isEnabled: () => boolean;
}

export class DeskService {
  constructor(readonly repo: DeskRepository, private readonly ports: DeskServicePorts) {}

  submit(input: SubmitDeskInput): SubmitDeskOutcome {
    const origin = originOfRequestKey(input.requestKey);
    if (!origin) return { kind: "invalid", problem: "受付キーの形が違います" };
    const problem = deskBodyProblem(input.body);
    if (problem) return { kind: "invalid", problem };
    const requester = input.requester.trim().slice(0, DESK_REQUESTER_MAX_CHARS) || "unknown";
    return this.repo.transaction((): SubmitDeskOutcome => {
      const existing = this.repo.findByKey(input.requestKey);
      const decision = decideSubmission(existing, input);
      // 受付済みの再送は OFF 後でも既存を返す (結果不明の照合を止めない)。
      if (decision === "existing") return { kind: "existing", request: existing! };
      if (decision === "conflict") return { kind: "conflict", request: existing! };
      if (!this.ports.isEnabled()) return { kind: "disabled" };
      const request = this.repo.insert({
        id: this.ports.id(), request_key: input.requestKey, origin, requester, provider: input.provider, body: input.body.trim(),
      }, this.ports.now());
      return { kind: "created", request };
    });
  }

  list(limit = 50): DeskRequest[] {
    return this.repo.list(Math.max(1, Math.min(limit, 200)));
  }

  get(id: string): DeskRequest | null {
    return this.repo.find(id);
  }

  findBySession(sessionId: string): DeskRequest | null {
    return this.repo.findBySession(sessionId);
  }

  attachThread(id: string, threadId: string): boolean {
    return this.repo.attachThread(id, threadId);
  }
}
