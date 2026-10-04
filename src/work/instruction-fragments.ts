import { createHash } from "node:crypto";

export interface InstructionFragment { content: string; sourceEventId: string }

/** Immutable instruction items, with deterministic replay IDs. No LLM rewriting of requirements. */
export function instructionFragments(reference: string, title: string, body: string): InstructionFragment[] {
  if (isBugInstruction(undefined, title)) return [];
  const lines = body.split(/\r?\n/);
  const items: string[] = [];
  let item: string[] | null = null;
  let fence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) fence = !fence;
    if (!fence && /^\d+[.)．、]\s*\S/.test(line)) {
      if (item) items.push(item.join("\n").trim());
      item = [line];
    } else if (item && /^#{1,6}\s/.test(line) && !fence) {
      items.push(item.join("\n").trim()); item = null;
    } else if (item) item.push(line);
  }
  if (item) items.push(item.join("\n").trim());
  return (items.length ? items : [body.trim()]).filter(text => text && !isBugInstruction(undefined, text)).map(text => {
    const content = `[Cc 実装指示: ${reference}]\n${title}\n\n${text}`;
    if (content.length > 20_000) throw new Error("instruction_fragment_too_large");
    const hex = createHash("sha256").update(`${reference}\0${content}`).digest("hex");
    return { content, sourceEventId: `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}` };
  });
}

export type FragmentSyncResult = { state: "registered"; count: number; project_id: string }
  | { state: "not_registered" } | { state: "unavailable" } | { state: "excluded_bug" } | { state: "excluded_private" };

/** Bug reports remain in the task/incident owner, never the specification-fragment feed. */
export function isBugInstruction(kind: string | undefined, title: string): boolean {
  const itemTitle = title.replace(/^\s*\d+[.)．、]\s*/gm, "");
  return /^(?:bug|bugfix|defect|incident|バグ|不具合|障害)(?:$|[-_: ]|修正|報告)/i.test(kind ?? "")
    || /(?:\[(?:bug|bugfix|バグ|不具合|障害)[^\]]*\]|(?:バグ|不具合|障害)(?:報告|修正)|^(?:bug|bugfix|fix)\s*[:：])/im.test(itemTitle);
}

export interface FragmentSyncPorts {
  /** Resolve the exact registered project from the checkout, never guess by display name. */
  project(repo: string, origin: string | null): Promise<string | null>;
  post(project: string, fragment: InstructionFragment): Promise<void>;
}

export async function syncInstructionFragments(ports: FragmentSyncPorts,
  input: { repo: string; origin: string | null; reference: string; title: string; body: string; kind?: string; privateConsultation?: boolean }): Promise<FragmentSyncResult> {
  if (input.privateConsultation) return { state: "excluded_private" };
  if (isBugInstruction(input.kind, input.title)) return { state: "excluded_bug" };
  try {
    const fragments = instructionFragments(input.reference, input.title, input.body);
    if (!fragments.length) return { state: "excluded_bug" };
    const project = await ports.project(input.repo, input.origin);
    if (!project) return { state: "not_registered" };
    for (const fragment of fragments) await ports.post(project, fragment);
    return { state: "registered", count: fragments.length, project_id: project };
  } catch {
    // The instruction link remains authoritative. The same link retries exact immutable IDs.
    return { state: "unavailable" };
  }
}
