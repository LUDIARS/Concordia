import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SprintDialoguesRepository } from '../sprint-dialogues/repository.js';
import { sprintDialoguesRouter } from './sprint-dialogues.js';
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup(local = true) { const db = new Database(':memory:'); databases.push(db); return sprintDialoguesRouter(new SprintDialoguesRepository(db), () => local); }
const value = { version: 1, dialogueKey: 'actio:t:s', teamId: 't', sprintId: 's', sprintName: 'Sprint', phase: 'planning', revision: 1,
  sourceFingerprint: 'a'.repeat(64), held: false, closed: false, reason: '計画', summary: '確認', taskIds: ['task'], actioPath: '/tasks/planning?team=t&sprint=s' };
describe('sprint service API', () => {
  it('preserves a pending receipt and never exposes a human-event write route', async () => {
    const app = setup();
    const result = await app.request('/actio%3At%3As', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
    expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ dialogue: { dialogueKey: 'actio:t:s', revision: 1, deliveryStatus: 'pending', threadUrl: null } });
    expect((await app.request('/events', { method: 'POST', body: JSON.stringify({ actor: 'forged' }) })).status).toBe(404);
    expect((await app.request('/actio%3At%3As', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...value, summary: '別内容' }) })).status).toBe(409);
  });
  it('rejects browser/proxy ingress, remote requests and callback URL injection', async () => {
    expect((await setup(false).request('/events')).status).toBe(403);
    expect((await setup().request('/events', { headers: { origin: 'https://attacker.invalid' } })).status).toBe(403);
    expect((await setup().request('/events', { headers: { 'x-forwarded-for': '192.0.2.1' } })).status).toBe(403);
    expect((await setup().request('/actio%3At%3As', { method: 'PUT', body: JSON.stringify({ ...value, actioPath: '//attacker.invalid' }) })).status).toBe(400);
  });
});
