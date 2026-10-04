import { describe, expect, it, vi } from 'vitest';
import type { DiscordConfigRepo } from '../db/discord-repo.js';
import { createConsultationTitleUpdater, type ConsultationTitleSnapshot } from './consultation-title.js';
function fixture() {
  const values = new Map<string, string>();
  const config: DiscordConfigRepo = { get: key => values.get(key) ?? null, set: (key, value) => { values.set(key, value); },
    delete: key => { values.delete(key); }, all: () => Object.fromEntries(values),
    compareAndSwap: (key, old, value) => {
      if ((values.get(key) ?? null) !== old) return false;
      if (value === null) values.delete(key); else values.set(key, value); return true;
    } };
  let snapshot: ConsultationTitleSnapshot | null = { channelId: 'thread', source: '長い予算についての相談です', nameBody: '長い元入力' };
  let name = '長い元入力';
  const rename = vi.fn(async (next: string) => { name = next; });
  const remember = vi.fn((_id: string, title: string) => { if (snapshot) snapshot = { ...snapshot, nameBody: title }; });
  const ports = { config, read: () => snapshot, summarize: vi.fn(async () => ({ title: '予算の相談', changed: true })),
    surface: async () => ({ name, rename }), format: (_id: string, title: string) => `[Cc] ${title}`, remember, warn: vi.fn() };
  return { ports, values, rename, remember, set: (next: ConsultationTitleSnapshot | null) => { snapshot = next; },
    current: () => snapshot, setName: (next: string) => { name = next; } };
}
describe('consultation name delivery', () => {
  it('renames initially, keeps a thin change, and updates a new topic', async () => {
    const f = fixture(), updater = createConsultationTitleUpdater(f.ports);
    updater.request('s'); await vi.waitFor(() => expect(f.remember).toHaveBeenCalledTimes(1));
    f.set({ ...f.current()!, source: '予算の追加説明です' });
    f.ports.summarize.mockResolvedValue({ title: '予算について', changed: false });
    updater.request('s'); await vi.waitFor(() => expect(f.ports.summarize).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(JSON.parse(f.values.get('consultation_title:s')!).phase).toBe('done'));
    expect(f.rename).toHaveBeenCalledTimes(1);
    f.set({ ...f.current()!, source: '接続障害に話題が変わります' });
    f.ports.summarize.mockResolvedValue({ title: '接続障害', changed: true });
    updater.request('s'); await vi.waitFor(() => expect(f.rename).toHaveBeenCalledTimes(2));
    updater.stop();
  });
  it('discards results when the source, lock or ownership changes during generation', async () => {
    for (const change of ['source', 'protected', 'channel'] as const) {
      const f = fixture(); let resolve!: (value: { title: string; changed: boolean }) => void;
      f.ports.summarize.mockImplementation(() => new Promise(done => { resolve = done; }));
      const updater = createConsultationTitleUpdater(f.ports); updater.request('s');
      await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
      f.set(change === 'protected' ? null : { ...f.current()!, ...(change === 'source' ? { source: '新しい話題' } : { channelId: 'other' }) });
      resolve({ title: '古い要約', changed: true });
      await new Promise(done => setTimeout(done, 0));
      expect(f.rename).not.toHaveBeenCalled(); updater.stop();
    }
  });
  it('reconciles an unknown rename without repeating it across a restart', async () => {
    const f = fixture(); f.rename.mockImplementation(async next => { f.setName(next); throw Error('response lost'); });
    const first = createConsultationTitleUpdater(f.ports); first.request('s');
    await vi.waitFor(() => expect(f.ports.warn).toHaveBeenCalled()); first.stop();
    const second = createConsultationTitleUpdater(f.ports); second.request('s');
    await vi.waitFor(() => expect(f.remember).toHaveBeenCalledTimes(1));
    expect(f.rename).toHaveBeenCalledTimes(1); second.stop();
  });
  it('holds an unresolved rename and preserves a result confirmed after stop', async () => {
    const f = fixture(); let complete!: () => void;
    f.rename.mockImplementation(next => new Promise<void>(done => { complete = () => { f.setName(next); done(); }; }));
    const first = createConsultationTitleUpdater(f.ports); first.request('s');
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    const beforeStop = f.current(); first.stop(); f.set(null); complete();
    await vi.waitFor(() => expect(JSON.parse(f.values.get('consultation_title:s')!).phase).toBe('done'));
    f.set(beforeStop);
    const resumed = createConsultationTitleUpdater(f.ports); resumed.request('s');
    await vi.waitFor(() => expect(f.current()?.nameBody).toBe('予算の相談'));
    expect(f.rename).toHaveBeenCalledTimes(1); resumed.stop();
    const g = fixture(); g.rename.mockRejectedValue(Error('timeout'));
    const uncertain = createConsultationTitleUpdater(g.ports); uncertain.request('s');
    await vi.waitFor(() => expect(g.ports.warn).toHaveBeenCalled()); uncertain.stop();
    const restart = createConsultationTitleUpdater(g.ports); restart.request('s');
    await vi.waitFor(() => expect(g.ports.warn).toHaveBeenCalledTimes(2));
    expect(g.rename).toHaveBeenCalledTimes(1); restart.stop();
  });
  it('does not generate a title for a private or locked surface', async () => {
    const f = fixture(); f.set(null);
    const updater = createConsultationTitleUpdater(f.ports); updater.request('s');
    expect(f.ports.summarize).not.toHaveBeenCalled(); updater.stop();
  });
  it('refreshes project decoration using the saved summary without another model call', async () => {
    const f = fixture(), updater = createConsultationTitleUpdater(f.ports);
    updater.request('s'); await vi.waitFor(() => expect(f.remember).toHaveBeenCalledTimes(1));
    f.ports.format = (_id, title) => `[Cc+Pf] ${title}`;
    updater.request('s'); await vi.waitFor(() => expect(f.rename).toHaveBeenCalledWith('[Cc+Pf] 予算の相談'));
    expect(f.ports.summarize).toHaveBeenCalledTimes(1); updater.stop();
  });
});
