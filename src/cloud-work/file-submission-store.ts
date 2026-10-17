import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CloudReceipt, CloudSubmission, CloudSubmissionStore } from "./submission.js";

/** Local durable intent journal; never use a worktree or synced/public folder as root. */
export class FileCloudSubmissionStore implements CloudSubmissionStore {
  constructor(private readonly root: string) {}

  private path(attemptId: string, suffix: string): string {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(attemptId)) throw new Error("invalid_cloud_attempt_id");
    return join(this.root, `${attemptId}.${suffix}.json`);
  }

  async reserve(request: CloudSubmission): Promise<boolean> {
    const path = this.path(request.attemptId, "intent");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const handle = await open(path, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") return null;
      throw error;
    });
    if (!handle) return false;
    try {
      await handle.writeFile(JSON.stringify(request), { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  }

  async recordReceipt(attemptId: string, receipt: CloudReceipt): Promise<void> {
    await this.writeRecord(attemptId, "receipt", receipt);
  }

  async readRecord(attemptId: string, kind: "intent" | "receipt" | "reconciliation" | "verified"): Promise<unknown | null> {
    try { return JSON.parse(await readFile(this.path(attemptId, kind), "utf8")) as unknown; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("cloud_journal_incomplete");
    }
  }

  async writeRecord(attemptId: string, kind: "receipt" | "reconciliation" | "verified", value: unknown): Promise<void> {
    const handle = await open(this.path(attemptId, kind), "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value), { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
