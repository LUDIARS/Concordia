import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StatusProjection } from "./policy.js";
import { statusPages } from "./render.js";

export interface StatusChannelPort {
  send(content: string, nonce: string): Promise<string>;
  edit(id: string, content: string): Promise<void | boolean>;
  remove(id: string): Promise<void>;
  findNonce(nonce: string): Promise<string | null>;
}
export interface StatusStore { get(key: string): string | null; set(key: string, value: string): void }
const MessageIdSchema = z.string().regex(/^\d{1,30}$/);
const StatusServiceSchema = z.object({
  siteId: z.string().min(1).max(200),
  code: z.string().min(1).max(200),
  name: z.string().min(1).max(500),
  project: z.string().max(200).nullable(),
  repository: z.string().max(1_000).nullable(),
  state: z.enum(["up", "down", "unknown", "unmonitored"]),
  checkedAt: z.number().finite().nonnegative().nullable(),
}).strict();
const LedgerSchema = z.object({
  pages: z.array(MessageIdSchema).max(1_000),
  history: z.array(MessageIdSchema).max(50),
  previous: z.array(StatusServiceSchema).max(1_000).nullable(),
  scope: z.string().max(4_000_000),
}).strict();
const PendingSchema = z.object({
  nonce: z.string().regex(/^[0-9a-f]{24}$/),
  kind: z.enum(["page", "history"]),
  index: z.number().int().nonnegative().max(1_000),
  previous: z.array(StatusServiceSchema).max(1_000).optional(),
}).strict();
type Ledger = z.infer<typeof LedgerSchema>;
type Pending = z.infer<typeof PendingSchema>;
const KEY = "service_status_ledger";
const PENDING = "service_status_pending";

/** @implements CC-SS-05 CC-SS-06 CC-SS-09 — summary only; reconcile uncertain legacy writes before deletion. */
export class StatusPublisher {
  private busy = false;
  constructor(private readonly store: StatusStore, private readonly channel: StatusChannelPort) {}
  private read(): Ledger {
    const raw = this.store.get(KEY);
    if (!raw) return { pages: [], history: [], previous: null, scope: "" };
    try { return LedgerSchema.parse(JSON.parse(raw)); }
    catch { throw new Error("invalid_service_status_ledger"); }
  }
  private save(ledger: Ledger) { this.store.set(KEY, JSON.stringify(ledger)); }
  private async settle(ledger: Ledger) {
    const raw = this.store.get(PENDING);
    if (!raw) return;
    let pending: Pending;
    try { pending = PendingSchema.parse(JSON.parse(raw)); }
    catch { throw new Error("invalid_service_status_pending"); }
    const id = await this.channel.findNonce(pending.nonce);
    if (!id) throw new Error("service_status_send_unknown_manual_reconciliation_required");
    if (pending.kind === "page") ledger.pages[pending.index] = id;
    else if (!ledger.history.includes(id)) ledger.history.push(id);
    if (pending.previous) ledger.previous = pending.previous;
    this.save(ledger); this.store.set(PENDING, "");
  }
  private async send(ledger: Ledger, content: string, index: number) {
    const nonce = randomUUID().replace(/-/g, "").slice(0, 24);
    this.store.set(PENDING, JSON.stringify({ nonce, kind: "page", index } satisfies Pending));
    const id = await this.channel.send(content, nonce);
    ledger.pages[index] = id;
    this.save(ledger); this.store.set(PENDING, "");
  }
  async refresh(projection: StatusProjection | null, scope: string, stopped: () => boolean = () => false): Promise<void> {
    if (this.busy || stopped()) return;
    this.busy = true;
    try {
      const ledger = this.read();
      if (stopped()) return;
      await this.settle(ledger);
      if (stopped()) return;
      // Remove old history, including reconciled sends, even during an observation outage.
      while (ledger.history.length) {
        if (stopped()) return;
        await this.channel.remove(ledger.history[0]!);
        ledger.history.shift(); this.save(ledger);
      }
      ledger.previous = null; this.save(ledger);
      if (scope !== ledger.scope) {
        // Revoke every owned old post before publishing a new scope; failures block disclosure.
        for (const id of [...ledger.pages, ...ledger.history]) { if (stopped()) return; await this.channel.remove(id); }
        ledger.pages = []; ledger.history = []; ledger.previous = null; ledger.scope = scope; this.save(ledger);
      }
      const pages = statusPages(projection);
      for (let index = 0; index < pages.length; index++) {
        if (stopped()) return;
        const id = ledger.pages[index];
        if (id) {
          const present = await this.channel.edit(id, pages[index]!);
          if (present === false) await this.send(ledger, pages[index]!, index);
        }
        else await this.send(ledger, pages[index]!, index);
      }
      for (const id of ledger.pages.slice(pages.length)) { if (stopped()) return; await this.channel.remove(id); }
      ledger.pages = ledger.pages.slice(0, pages.length); this.save(ledger);
    } finally { this.busy = false; }
  }
}
