// @spec ハーネス信頼性の実装境界
import type { SessionsRepo } from "../../db/sessions-repo.js";
import { readState, type ReliabilityState, type PromptSample } from "./state.js";

export class ReliabilityStore {
  constructor(private readonly sessions: SessionsRepo) {}

  read(id: string): ReliabilityState {
    const row = this.sessions.findSession(id);
    if (!row) throw new Error("session not found");
    return readState(row.metadata ? JSON.parse(row.metadata) : {});
  }

  update(id: string, change: (state: ReliabilityState) => void): ReliabilityState {
    this.sessions.updateMetadata(id, (metadata) => {
      const state = readState(metadata);
      change(state);
      return { ...metadata, harness_reliability: state };
    });
    return this.read(id);
  }

  /** On-demand history only, scoped to one recorded user, repository and team. */
  history(id: string, since: number): PromptSample[] {
    const session = this.sessions.findSession(id);
    if (!session) return [];
    const latest = this.read(id).samples.at(-1);
    if (!latest) return [];
    if (!latest.user_key) return this.read(id).samples.filter((item) => item.user_label === latest.user_label && !item.user_key && item.at >= since).slice(-32);
    const sessions = this.sessions.listSessions({ limit: 200, ...(session.repo_origin ? { repo_origin: session.repo_origin } : {}) });
    const samples = sessions.filter((row) => row.team_id === session.team_id && (session.repo_origin ? row.repo_origin === session.repo_origin : row.repo_path === session.repo_path))
      .flatMap((row) => this.read(row.id).samples.filter((item) => item.user_key === latest.user_key && item.at >= since));
    return samples.sort((a, b) => a.at - b.at).slice(-32);
  }
}
