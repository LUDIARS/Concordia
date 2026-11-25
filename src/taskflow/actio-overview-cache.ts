/** @implements spec/feature/taskflow-failure-visibility.md CC-TF-READ-03 */
import { createChildLogger } from "../shared/logger.js";
import { repositoryKey } from "./actio-binding.js";
import { selectActioOverviewSnapshot } from "./actio-overview-cache-policy.js";
import { describeTaskflowFailure } from "./failure.js";
import { taskflowFailureLogFields } from "./failure-diagnostics.js";
import type { TaskOverviewScan } from "./store.js";
import type { TaskDocument } from "./types.js";

const FRESH_MS = 30_000;
const RETRY_MS = 5_000;
const COLD_WAIT_MS = 400;
const PROJECT_LIMIT = 64;
const log = createChildLogger("taskflow/actio-overview");
const retainOnFailure = new Set([
  "actio_read_timeout", "actio_unreachable", "actio_unavailable", "actio_response_invalid",
  "actio_service_lookup_failed", "actio_outcome_unknown",
]);

type Scope = string | null;
type Load = () => Promise<TaskOverviewScan>;
type Snapshot = TaskOverviewScan & { fetchedAt: number; complete: boolean };
interface Entry {
  snapshot?: Snapshot;
  writes: Map<string, TaskDocument>;
  revision: number;
  nextReadAt: number;
  error: string | null;
  refresh?: Promise<void>;
}

export class ActioOverviewCache {
  private readonly entries = new Map<Scope, Entry>();
  private readonly queue = new Map<Entry, () => Promise<void>>();
  private active = false;

  constructor(private readonly now: () => number = Date.now) {}

  async read(scope: Scope, load: Load): Promise<TaskOverviewScan> {
    const entry = this.entry(scope);
    if (!entry.refresh && this.now() >= entry.nextReadAt) this.enqueue(entry, load);
    if (!entry.snapshot && !entry.writes.size && !entry.error && entry.refresh) {
      await waitForInitialRead(entry.refresh);
    }
    return this.view(entry);
  }

  record(document: TaskDocument): void {
    for (const scope of [null, document.frontmatter.project.toLowerCase()]) {
      const entry = this.entry(scope);
      entry.revision++;
      entry.nextReadAt = 0;
      entry.writes.set(taskKey(document), document);
    }
  }

  private entry(scope: Scope): Entry {
    const existing = this.entries.get(scope);
    if (existing) {
      this.entries.delete(scope);
      this.entries.set(scope, existing);
      return existing;
    }
    if (scope !== null && this.entries.size - Number(this.entries.has(null)) >= PROJECT_LIMIT) {
      for (const [key, entry] of this.entries) {
        if (key === null) continue;
        // A queued read can be skipped. An active read finishes before the next one starts.
        this.entries.delete(key);
        this.queue.delete(entry);
        break;
      }
    }
    const entry: Entry = { writes: new Map(), revision: 0, nextReadAt: 0, error: null };
    this.entries.set(scope, entry);
    return entry;
  }

  private enqueue(entry: Entry, load: Load): void {
    entry.refresh = new Promise((resolve) => {
      this.queue.set(entry, async () => {
        try { await this.refresh(entry, load); }
        finally {
          delete entry.refresh;
          resolve();
        }
      });
    });
    if (!this.active) void this.drain();
  }

  private async drain(): Promise<void> {
    this.active = true;
    try {
      for (const [entry, refresh] of this.queue) {
        this.queue.delete(entry);
        await refresh();
      }
    } finally {
      this.active = false;
    }
  }

  private async refresh(entry: Entry, load: Load): Promise<void> {
    const revision = entry.revision;
    try {
      const scan = await load();
      const candidate: Snapshot = { ...scan, fetchedAt: this.now(), complete: !scan.partialReason };
      entry.snapshot = selectActioOverviewSnapshot(entry.snapshot, candidate, revision, entry.revision);
      if (entry.snapshot === candidate && candidate.complete) entry.writes.clear();
      if (revision !== entry.revision) return;
      entry.error = scan.partialReason ?? null;
      entry.nextReadAt = candidate.fetchedAt + (candidate.complete ? FRESH_MS : RETRY_MS);
    } catch (error) {
      if (revision !== entry.revision) return;
      const failure = describeTaskflowFailure(error);
      log.warn(taskflowFailureLogFields(failure, error), "Actio overview refresh failed");
      if (!retainOnFailure.has(failure.code)) {
        delete entry.snapshot;
        entry.writes.clear();
      }
      entry.error = failure.code;
      entry.nextReadAt = this.now() + RETRY_MS;
    }
  }

  private view(entry: Entry): TaskOverviewScan {
    const snapshot = entry.snapshot;
    const documents = snapshot?.documents ?? [];
    const merged = entry.writes.size ? new Map(documents.map((document) => [taskKey(document), document])) : undefined;
    if (merged) for (const [key, document] of entry.writes) merged.set(key, document);
    return {
      documents: merged ? Array.from(merged.values()) : documents,
      partialReason: snapshot?.partialReason,
      freshness: {
        fetched_at: snapshot ? new Date(snapshot.fetchedAt).toISOString() : null,
        refreshing: !!entry.refresh,
        stale: !!snapshot && (!snapshot.complete || !!entry.error || !!entry.writes.size || this.now() - snapshot.fetchedAt >= FRESH_MS),
        refresh_error: entry.error,
      },
    };
  }
}

function taskKey(document: TaskDocument): string {
  return JSON.stringify([repositoryKey(document.repoPath), document.runtime?.subsidiary_id, document.path]);
}

async function waitForInitialRead(refresh: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([refresh, new Promise<void>((resolve) => { timer = setTimeout(resolve, COLD_WAIT_MS); })]);
  } finally {
    clearTimeout(timer);
  }
}
