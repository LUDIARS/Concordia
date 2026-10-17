import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { lstatSync } from "node:fs";
import { z } from "zod";
import { answerObservation, applyObservation, initialObservation, type ObservationEvent, type ObservationState } from "./state.js";

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export interface ObservedRun { target: string; attempt: string; state: ObservationState; revision: number }
interface Row { target: string; attempt: string; state: string; revision: number }

/** Dedicated observation database shared by the receiver and the Discord adapter.
 * No Actio, submission or artifact state is written here.
 */
export class ObservationStore {
  private readonly db: Database.Database;
  constructor(root: string) {
    const info = lstatSync(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("observation_root_invalid");
    const path = join(root, "observations.sqlite");
    try { if (lstatSync(path).isSymbolicLink()) throw new Error("observation_file_invalid"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.db = new Database(path);
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("busy_timeout = 1000");
      this.db.exec(`CREATE TABLE IF NOT EXISTS observation_runs (
        target TEXT NOT NULL, attempt TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL,
        PRIMARY KEY(target, attempt));
        CREATE TABLE IF NOT EXISTS observation_events (
        target TEXT NOT NULL, attempt TEXT NOT NULL, sequence INTEGER NOT NULL, event TEXT NOT NULL,
        PRIMARY KEY(target, attempt, sequence));
        CREATE TABLE IF NOT EXISTS observation_previews (
        target TEXT NOT NULL, attempt TEXT NOT NULL, id TEXT NOT NULL, sha TEXT NOT NULL,
        name TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(target, attempt, id));`);
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  get(target: string, attempt: string): ObservedRun | null {
    Id.parse(target); Id.parse(attempt);
    const row = this.db.prepare("SELECT * FROM observation_runs WHERE target=? AND attempt=?").get(target, attempt) as Row | undefined;
    return row ? { ...row, state: JSON.parse(row.state) as ObservationState } : null;
  }
  list(): ObservedRun[] {
    const rows = this.db.prepare("SELECT * FROM observation_runs ORDER BY rowid DESC LIMIT 200").all() as Row[];
    return rows.map(row => ({ ...row, state: JSON.parse(row.state) as ObservationState }));
  }
  receive(target: string, attempt: string, event: unknown, now: number): ObservedRun {
    return this.db.transaction(() => {
      const current = this.get(target, attempt);
      if (!current && (this.db.prepare("SELECT count(*) AS total FROM observation_runs").get() as { total: number }).total >= 200)
        throw new Error("observation_run_capacity_reached");
      const state = applyObservation(current?.state ?? initialObservation(), event, now);
      if (state.lastEvent?.kind === "preview" && !this.preview(target, attempt, state.lastEvent.previewId!))
        throw new Error("observation_preview_missing");
      if (current && state === current.state) return current;
      const revision = (current?.revision ?? 0) + 1;
      this.db.prepare("INSERT INTO observation_events VALUES(?,?,?,?)")
        .run(target, attempt, state.lastEvent!.sequence, JSON.stringify(state.lastEvent));
      this.db.prepare(`INSERT INTO observation_runs(target,attempt,state,revision) VALUES(?,?,?,?)
        ON CONFLICT(target,attempt) DO UPDATE SET state=excluded.state,revision=excluded.revision`)
        .run(target, attempt, JSON.stringify(state), revision);
      return { target, attempt, state, revision };
    }).immediate();
  }
  events(target: string, attempt: string, after: number): ObservationEvent[] {
    const rows = this.db.prepare("SELECT event FROM observation_events WHERE target=? AND attempt=? AND sequence>? ORDER BY sequence LIMIT 20")
      .all(target, attempt, after) as Array<{ event: string }>;
    return rows.map(row => JSON.parse(row.event) as ObservationEvent);
  }
  answer(target: string, attempt: string, question: string, text: string, author: string, now: number): ObservedRun {
    return this.db.transaction(() => {
      const current = this.get(target, attempt);
      if (!current) throw new Error("observation_not_found");
      const state = answerObservation(current.state, question, text, author, now);
      const revision = current.revision + 1;
      this.db.prepare("UPDATE observation_runs SET state=?,revision=? WHERE target=? AND attempt=?")
        .run(JSON.stringify(state), revision, target, attempt);
      return { target, attempt, state, revision };
    }).immediate();
  }
  savePreview(target: string, attempt: string, id: string, bytes: Buffer): void {
    Id.parse(target); Id.parse(attempt); Id.parse(id);
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error("preview_size_invalid");
    const png = bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      && bytes.toString("ascii", 12, 16) === "IHDR";
    const jpeg = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
    if (!png && !jpeg) throw new Error("preview_format_invalid");
    const sha = createHash("sha256").update(bytes).digest("hex");
    this.db.transaction(() => {
      const prior = this.db.prepare("SELECT sha FROM observation_previews WHERE target=? AND attempt=? AND id=?")
        .get(target, attempt, id) as { sha: string } | undefined;
      if (prior) { if (prior.sha !== sha) throw new Error("preview_replay_conflict"); return; }
      const usage = this.db.prepare("SELECT COALESCE(SUM(length(bytes)),0) AS total FROM observation_previews WHERE target=? AND attempt=?")
        .get(target, attempt) as { total: number };
      if (usage.total + bytes.length > 32 * 1024 * 1024) throw new Error("preview_run_limit");
      this.db.prepare("INSERT INTO observation_previews VALUES(?,?,?,?,?,?)")
        .run(target, attempt, id, sha, png ? "preview.png" : "preview.jpg", bytes);
    }).immediate();
  }
  preview(target: string, attempt: string, id: string): { name: string; bytes: Buffer } | null {
    return this.db.prepare("SELECT name,bytes FROM observation_previews WHERE target=? AND attempt=? AND id=?")
      .get(target, attempt, id) as { name: string; bytes: Buffer } | undefined ?? null;
  }
}
