import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionRow } from "../shared/types.js";
import { readSessionContextObservation } from "./context-observation-reader.js";

// isolate:false shares previously loaded modules. Inject this boundary per call instead
// of relying on a global module mock that depends on test-file execution order.
const readFixtureObservation = (session: SessionRow) =>
  readSessionContextObservation(session, async (bound) => bound.transcript_path);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true }))); });
async function fixture(text: string): Promise<SessionRow> {
  const directory = await mkdtemp(join(tmpdir(), "context-observation-"));
  directories.push(directory);
  const path = join(directory, "session.jsonl");
  await writeFile(path, text, "utf8");
  return { provider: "codex-cli", transcript_path: path } as SessionRow;
}
const usage = (input: number) => JSON.stringify({ type: "event_msg", payload: { type: "token_count",
  info: { last_token_usage: { input_tokens: input }, model_context_window: 258400 } } });

describe("bounded context reader", () => {
  it("does not recover old measurements outside the tail and reads appended complete measurements", async () => {
    const session = await fixture(`${usage(90000)}\n${"x".repeat(2 * 1024 * 1024)}\n`);
    expect(await readFixtureObservation(session)).toBeNull();
    await appendFile(session.transcript_path!, `${usage(23000)}\n`, "utf8");
    const observation = await readFixtureObservation(session);
    expect(observation?.tokens).toBe(23000);
    expect(await readFixtureObservation(session)).toBe(observation);
  });
  it("ignores an incomplete record and invalidates the cache on truncation", async () => {
    const session = await fixture(`${usage(90000)}\n${usage(100000).slice(0, -2)}`);
    expect((await readFixtureObservation(session))?.tokens).toBe(90000);
    await writeFile(session.transcript_path!, `${usage(10000)}\n`, "utf8");
    expect((await readFixtureObservation(session))?.tokens).toBe(10000);
  });
});
