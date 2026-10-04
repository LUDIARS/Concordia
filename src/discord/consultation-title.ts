import { createHash } from 'node:crypto';
import type { DiscordConfigRepo } from '../db/discord-repo.js';
import { consultationTitlePrompt, chooseConsultationTitle } from '../consultation/title-summary.js';

export interface ConsultationTitleSnapshot {
  channelId: string; source: string; nameBody: string | null;
}
interface SavedTitle { channelId: string; sourceHash: string; title: string; target: string; phase: 'renaming' | 'done' }
export interface ConsultationTitlePorts {
  config: DiscordConfigRepo;
  /** null includes private, locked, ended, other organization and non-consultation surfaces. */
  read(sessionId: string): ConsultationTitleSnapshot | null;
  summarize(prompt: string, signal: AbortSignal): Promise<unknown>;
  surface(channelId: string): Promise<{ name: string; rename(name: string): Promise<unknown> } | null>;
  format(sessionId: string, title: string): string;
  remember(sessionId: string, title: string): void;
  warn(message: string): void;
}
const hash = (source: string): string => createHash('sha256').update(source).digest('hex');

/** @implements CC-CONSULT-TITLE-AT-03 @implements CC-CONSULT-TITLE-AT-04 @implements CC-CONSULT-TITLE-AT-05 */
export function createConsultationTitleUpdater(ports: ConsultationTitlePorts) {
  const abort = new AbortController(), pending = new Set<string>(), running = new Set<string>();
  let stopped = false;
  const key = (id: string): string => `consultation_title:${id}`;
  const readSaved = (raw: string | null): SavedTitle | null => {
    if (!raw) return null;
    const saved = JSON.parse(raw) as SavedTitle;
    if (!saved.channelId || !saved.sourceHash || !saved.title || !saved.target || !['done', 'renaming'].includes(saved.phase)) throw Error('Invalid naming record');
    return saved;
  };
  const run = async (id: string): Promise<void> => {
    let initial = ports.read(id);
    if (!initial || !initial.source.trim()) return;
    let raw = ports.config.get(key(id)), saved = readSaved(raw);
    if (saved && saved.channelId !== initial.channelId) throw Error('Naming ownership changed');
    if (saved?.phase === 'renaming') {
      const surface = await ports.surface(saved.channelId);
      if (!surface || surface.name !== saved.target) throw Error('Naming result unknown; reconciliation required');
      const done = { ...saved, phase: 'done' as const };
      if (!ports.config.compareAndSwap(key(id), raw, JSON.stringify(done))) return;
      raw = JSON.stringify(done); saved = done;
      const current = ports.read(id);
      if (current?.channelId === saved.channelId && hash(current.source) === saved.sourceHash) ports.remember(id, saved.title);
      initial = ports.read(id);
      if (!initial) return;
    }
    if (stopped) return;
    const sameSource = saved?.sourceHash === hash(initial.source);
    if (sameSource && saved && initial.nameBody !== saved.title) {
      ports.remember(id, saved.title);
      initial = ports.read(id);
      if (!initial) return;
    }
    if (sameSource && saved && saved.target === ports.format(id, saved.title)) return;
    const previous = saved?.title ?? null;
    const result = sameSource ? null : await ports.summarize(consultationTitlePrompt(initial.source, previous), abort.signal);
    const title = sameSource ? saved!.title : chooseConsultationTitle(result, previous);
    if (!title) throw Error('Invalid naming response');
    const current = ports.read(id);
    if (stopped || !current || current.channelId !== initial.channelId || current.source !== initial.source || current.nameBody !== initial.nameBody) return;
    if (title === previous && saved && saved.target === ports.format(id, title)) {
      ports.config.compareAndSwap(key(id), raw, JSON.stringify({ ...saved, sourceHash: hash(current.source) }));
      return;
    }
    const surface = await ports.surface(current.channelId);
    const latest = ports.read(id);
    if (stopped || !surface || !latest || latest.channelId !== current.channelId || latest.source !== current.source || latest.nameBody !== current.nameBody) return;
    const record: SavedTitle = { channelId: current.channelId, sourceHash: hash(current.source), title, target: ports.format(id, title), phase: 'renaming' };
    const claimed = JSON.stringify(record);
    if (!ports.config.compareAndSwap(key(id), raw, claimed)) return;
    if (surface.name !== record.target) await surface.rename(record.target);
    // Preserve confirmed external results even when stop arrived during the rename.
    if (!ports.config.compareAndSwap(key(id), claimed, JSON.stringify({ ...record, phase: 'done' }))) return;
    const final = ports.read(id);
    if (final?.channelId === current.channelId && final.source === current.source && final.nameBody === current.nameBody) ports.remember(id, title);
  };
  const drain = (): void => {
    if (stopped) return;
    for (const id of pending) {
      if (running.size >= 4) break;
      if (running.has(id)) continue;
      pending.delete(id); running.add(id);
      void run(id).catch(() => ports.warn(`consultation title failed; name preserved/reconciliation required session=${id}`))
        .finally(() => { running.delete(id); drain(); });
    }
  };
  return {
    request(id: string): void {
      if (stopped || !ports.read(id)) return;
      if (pending.size >= 32 && !pending.has(id)) { ports.warn('consultation title capacity reached'); return; }
      pending.add(id); drain();
    },
    stop(): void { stopped = true; pending.clear(); abort.abort(); },
  };
}
