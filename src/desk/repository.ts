/**
 * desk_requests の保存 (adapter)。遷移は revision の CAS で行い、負けたら null を返す。
 *
 * @implements spec/feature/request-desk.md — 状態の所有者 desk_requests
 */
import type Database from "better-sqlite3";
import { canTransition, type DeskRequest, type DeskState } from "./desk-request-policy.js";

export type DeskRequestPatch = Partial<Pick<DeskRequest, "state" | "spawn_id" | "session_id" | "launch_deadline_at" | "error">>;

export type NewDeskRequest = Pick<DeskRequest, "id" | "request_key" | "origin" | "requester" | "provider" | "body">;

export class DeskRepository {
  constructor(private readonly db: Database.Database) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  find(id: string): DeskRequest | null {
    return (this.db.prepare("SELECT * FROM desk_requests WHERE id = ?").get(id) as DeskRequest | undefined) ?? null;
  }

  findByKey(key: string): DeskRequest | null {
    return (this.db.prepare("SELECT * FROM desk_requests WHERE request_key = ?").get(key) as DeskRequest | undefined) ?? null;
  }

  findBySession(sessionId: string): DeskRequest | null {
    return (this.db.prepare("SELECT * FROM desk_requests WHERE session_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(sessionId) as DeskRequest | undefined) ?? null;
  }

  /** 新しい順。 */
  list(limit: number): DeskRequest[] {
    return this.db.prepare("SELECT * FROM desk_requests ORDER BY created_at DESC, id DESC LIMIT ?").all(limit) as DeskRequest[];
  }

  /** 古い順 (先に受けたものから起動する)。 */
  listByStates(states: readonly DeskState[], limit: number): DeskRequest[] {
    if (!states.length) return [];
    const marks = states.map(() => "?").join(",");
    return this.db.prepare(`SELECT * FROM desk_requests WHERE state IN (${marks}) ORDER BY created_at ASC, id ASC LIMIT ?`)
      .all(...states, limit) as DeskRequest[];
  }

  insert(input: NewDeskRequest, now: number): DeskRequest {
    this.db.prepare(`INSERT INTO desk_requests (id, request_key, origin, requester, provider, body, state, created_at, updated_at, revision)
      VALUES (@id, @request_key, @origin, @requester, @provider, @body, 'accepted', @now, @now, 1)`).run({ ...input, now });
    return this.find(input.id)!;
  }

  /** 状態の遷移。許されない遷移・他者が先に進めた (revision 違い) なら null。 */
  transition(current: DeskRequest, patch: DeskRequestPatch, now: number): DeskRequest | null {
    if (patch.state && patch.state !== current.state && !canTransition(current.state, patch.state)) return null;
    const next = { ...current, ...patch };
    const changed = this.db.prepare(`UPDATE desk_requests SET state = @state, spawn_id = @spawn_id, session_id = @session_id,
        launch_deadline_at = @launch_deadline_at, error = @error, updated_at = @now, revision = revision + 1
      WHERE id = @id AND revision = @revision`).run({
      id: current.id, revision: current.revision, now,
      state: next.state, spawn_id: next.spawn_id, session_id: next.session_id,
      launch_deadline_at: next.launch_deadline_at, error: next.error,
    }).changes;
    return changed === 1 ? this.find(current.id) : null;
  }

  /** Discord の依頼スレッドを覚える。既に別のスレッドがあれば変えない。 */
  attachThread(id: string, threadId: string): boolean {
    return this.db.prepare("UPDATE desk_requests SET discord_thread_id = ? WHERE id = ? AND (discord_thread_id IS NULL OR discord_thread_id = ?)")
      .run(threadId, id, threadId).changes === 1;
  }
}
