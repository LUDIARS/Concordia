/** Only transport delivery identity, never text/time alone, can identify an echo. */
export class InjectEchoLedger {
  private pending = new Map<string, { id: number; content: string; ts: number }>();
  remember(id: number, content: string, ts: number, deliveryId?: string): void {
    if (!deliveryId) return;
    this.pending.set(deliveryId, { id, content, ts });
    while (this.pending.size > 100) this.pending.delete(this.pending.keys().next().value!);
  }
  consume(content: string, ts: number, deliveryId?: string): number | null {
    for (const [key, item] of this.pending) if (ts - item.ts > 120) this.pending.delete(key);
    if (!deliveryId) return null;
    const item = this.pending.get(deliveryId);
    if (!item || item.content !== content || ts < item.ts) return null;
    this.pending.delete(deliveryId);
    return item.id;
  }
}
