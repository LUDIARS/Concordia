export type DeployNotifyTarget = { kind: "discord" | "slack" | "cc-channel"; target: string };

export interface ServiceDeployedEvent { code: string; previousHash: string; currentHash: string; version: string; startedAt: string; restartCount: number; }
export interface RevisorChanges { from: string; to: string; commits: Array<{ sha: string; subject: string }>; pullRequests: Array<{ number: number; title: string; author: string; mergedAt: string | null }>; markdown: string; notice: string; }
export interface DeploymentLedger { claim(code: string, currentHash: string): boolean; }
export interface DeploymentDelivery { discord(target: string, content: string): Promise<void>; slack(target: string, content: string): Promise<void>; ccChannel(content: string): Promise<void>; }
export interface DeploymentLookup { findProject(code: string): { repo_origin: string | null; deploy_notify: DeployNotifyTarget[] } | null; changes(repository: string, from: string, to: string): Promise<RevisorChanges | null>; }

export function composeDeploymentNotice(event: ServiceDeployedEvent, changes: RevisorChanges | null): string {
  const head = `[${event.code}] デプロイ反映 ${shortHash(event.previousHash)}→${shortHash(event.currentHash)} / ${event.version}`;
  if (!changes) return `${head}\n反映のみ（Revisor の差分情報を取得できませんでした）`;
  const notice = changes.notice.trim().split(/\r?\n/).slice(0, 10).join("\n");
  return [head, `merged PR ${changes.pullRequests.length} 本`, notice ? `> ${notice.replace(/\n/g, "\n> ")}` : ""].filter(Boolean).join("\n");
}

export async function deliverDeploymentNotice(input: { targets: readonly DeployNotifyTarget[]; content: string; delivery: DeploymentDelivery }): Promise<number> {
  let delivered = 0;
  for (const target of input.targets) {
    if (target.kind === "discord") await input.delivery.discord(target.target, input.content);
    else if (target.kind === "slack") await input.delivery.slack(target.target, input.content);
    else await input.delivery.ccChannel(input.content);
    delivered += 1;
  }
  return delivered;
}

export async function handleServiceDeployment(input: { event: ServiceDeployedEvent; ledger: DeploymentLedger; lookup: DeploymentLookup; delivery: DeploymentDelivery }): Promise<{ duplicate: boolean; delivered: number; fallback: boolean }> {
  if (!input.ledger.claim(input.event.code, input.event.currentHash)) return { duplicate: true, delivered: 0, fallback: false };
  const project = input.lookup.findProject(input.event.code);
  if (!project) return { duplicate: false, delivered: 0, fallback: true };
  let changes: RevisorChanges | null = null;
  if (project.repo_origin) { try { changes = await input.lookup.changes(project.repo_origin, input.event.previousHash, input.event.currentHash); } catch { changes = null; } }
  const delivered = await deliverDeploymentNotice({ targets: project.deploy_notify, content: composeDeploymentNotice(input.event, changes), delivery: input.delivery });
  return { duplicate: false, delivered, fallback: changes === null };
}

function shortHash(hash: string): string { return hash.slice(0, 7); }
