import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath, rename, writeFile, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { parseInputSchema, type DelegationRepo } from "../db/delegation-repo.js";
import type { InjectManualsRepo, InjectManualKind } from "../db/inject-manuals-repo.js";
import type { MajorInjectRepo } from "../db/major-inject-repo.js";
import { DEFAULT_MANUALS } from "./inject-manual-seed.js";
import {
  MAJOR_INJECT_DEFINITIONS, majorInjectDefinition, validateMajorInjectTemplate,
  type MajorInjectDefinition,
} from "./major-inject-catalog.js";

const MAX_BYTES = 32 * 1024;
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FILES = [
  { id: "rules.session_work", label: "セッション作業ルール", path: "rule/session-work.md" },
  { id: "rules.shared_context", label: "共有資料選択ルール", path: "rule/shared-context.md" },
  { id: "rules.session_work_phase", label: "作業段階スキル", path: "skills/session-work-phase/SKILL.md" },
  { id: "rules.session_followup", label: "セッション継続スキル", path: "skills/session-followup/SKILL.md" },
] as const;
const MANUAL_IDS: readonly [string, InjectManualKind][] = [
  ["design", "設計相談"], ["implementation", "実装"], ["review", "レビュー"],
  ["test", "テスト"], ["chore", "雑用"],
];

export interface InjectSourceSummary {
  id: string;
  label: string;
  workflow: string;
  case: string;
  target_kind: "builder" | "manual" | "template" | "file";
  origin: "builtin_override" | "inject_manuals" | "delegation_templates" | "repo_file";
  apply_scope: MajorInjectDefinition["apply_scope"];
  placeholders: string[];
  required_placeholders: string[];
  max_bytes: number;
  restorable: boolean;
  source_path?: string;
}
export interface InjectSource extends InjectSourceSummary {
  content: string;
  revision: string;
  updated_at?: number;
}

export class InjectSourceError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409, readonly detail?: unknown) {
    super(code);
  }
}

function revision(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Bounded, explicit catalog; template IDs are resolved only through existing DB rows. */
export class MajorInjectEditor {
  private readonly inFlight = new Map<string, Promise<unknown>>();
  constructor(
    private readonly overrides: MajorInjectRepo,
    private readonly manuals: InjectManualsRepo,
    private readonly templates: DelegationRepo,
  ) {}

  resolve = (id: string): string | null => {
    if (!majorInjectDefinition(id)) return null;
    return this.overrides.get(id)?.content ?? null;
  };

  list(): InjectSourceSummary[] {
    return [
      ...MAJOR_INJECT_DEFINITIONS.map((definition): InjectSourceSummary => ({
        id: definition.id, label: definition.label, workflow: definition.workflow, case: definition.case,
        target_kind: "builder", origin: "builtin_override", apply_scope: definition.apply_scope,
        placeholders: [...definition.placeholders], required_placeholders: [...definition.required_placeholders],
        max_bytes: MAX_BYTES, restorable: true,
      })),
      ...FILES.map((file): InjectSourceSummary => ({
        id: file.id, label: file.label, workflow: "rules", case: "file", target_kind: "file", origin: "repo_file",
        apply_scope: "next_file_read", placeholders: [], required_placeholders: [], max_bytes: MAX_BYTES,
        restorable: false, source_path: file.path,
      })),
      ...MANUAL_IDS.map(([key, kind]): InjectSourceSummary => ({
        id: `delegation.manual.${key}`, label: `kind: ${kind}`, workflow: "delegation", case: "manual",
        target_kind: "manual", origin: "inject_manuals", apply_scope: "next_delegation_launch",
        placeholders: [], required_placeholders: [], max_bytes: MAX_BYTES, restorable: true,
      })),
      ...this.templates.listTemplateSummaries().map((template): InjectSourceSummary => ({
        id: `delegation.template.${template.id}`, label: template.title, workflow: "delegation", case: "template",
        target_kind: "template", origin: "delegation_templates", apply_scope: "next_delegation_launch",
        placeholders: parseInputSchema(template.input_schema).map((item) => item.name),
        required_placeholders: [], max_bytes: MAX_BYTES, restorable: false,
      })),
    ];
  }

  async get(id: string): Promise<InjectSource> {
    const summary = this.summary(id);
    if (!summary) throw new InjectSourceError("unknown_target", 404);
    if (summary.target_kind !== "file") return this.getDbSource(summary);
    const file = FILES.find((item) => item.id === id)!;
    const path = await this.safeFilePath(file.path);
    const stat = await lstat(path);
    if (stat.size > MAX_BYTES) throw new InjectSourceError("content_too_large", 400, { max_bytes: MAX_BYTES });
    const content = await readFile(path, "utf8");
    return { ...summary, content, revision: revision(content) };
  }

  private getDbSource(summary: InjectSourceSummary): InjectSource {
    const id = summary.id;
    if (summary.target_kind === "builder") {
      const definition = majorInjectDefinition(id)!;
      const row = this.overrides.get(id);
      const content = row?.content ?? definition.default_content;
      return { ...summary, content, revision: revision(content), updated_at: row?.updated_at };
    }
    if (summary.target_kind === "manual") {
      const kind = MANUAL_IDS.find(([key]) => id === `delegation.manual.${key}`)![1];
      const row = this.manuals.get(kind);
      const content = row?.content ?? DEFAULT_MANUALS[kind];
      return { ...summary, content, revision: revision(content), updated_at: row?.updated_at };
    }
    if (summary.target_kind === "template") {
      const row = this.templates.findTemplate(id.slice("delegation.template.".length));
      if (!row) throw new InjectSourceError("unknown_target", 404);
      return { ...summary, content: row.prompt_template, revision: revision(row.prompt_template), updated_at: row.updated_at };
    }
    throw new InjectSourceError("unknown_target", 404);
  }

  private summary(id: string): InjectSourceSummary | null {
    const definition = majorInjectDefinition(id);
    if (definition) return {
      id, label: definition.label, workflow: definition.workflow, case: definition.case,
      target_kind: "builder", origin: "builtin_override", apply_scope: definition.apply_scope,
      placeholders: [...definition.placeholders], required_placeholders: [...definition.required_placeholders],
      max_bytes: MAX_BYTES, restorable: true,
    };
    const file = FILES.find((item) => item.id === id);
    if (file) return {
      id, label: file.label, workflow: "rules", case: "file", target_kind: "file", origin: "repo_file",
      apply_scope: "next_file_read", placeholders: [], required_placeholders: [], max_bytes: MAX_BYTES,
      restorable: false, source_path: file.path,
    };
    const manual = MANUAL_IDS.find(([key]) => id === `delegation.manual.${key}`);
    if (manual) return {
      id, label: `kind: ${manual[1]}`, workflow: "delegation", case: "manual", target_kind: "manual",
      origin: "inject_manuals", apply_scope: "next_delegation_launch", placeholders: [], required_placeholders: [],
      max_bytes: MAX_BYTES, restorable: true,
    };
    if (!id.startsWith("delegation.template.")) return null;
    const template = this.templates.findTemplate(id.slice("delegation.template.".length));
    return template ? {
      id, label: template.title, workflow: "delegation", case: "template", target_kind: "template",
      origin: "delegation_templates", apply_scope: "next_delegation_launch",
      placeholders: parseInputSchema(template.input_schema).map((item) => item.name),
      required_placeholders: [], max_bytes: MAX_BYTES, restorable: false,
    } : null;
  }

  async put(id: string, content: string, expectedRevision: string): Promise<InjectSource> {
    return this.serial(id, async () => {
      if (Buffer.byteLength(content, "utf8") > MAX_BYTES) throw new InjectSourceError("content_too_large", 400, { max_bytes: MAX_BYTES });
      const summary = this.summary(id);
      if (!summary) throw new InjectSourceError("unknown_target", 404);
      if (summary.target_kind === "file") {
        const current = await this.get(id);
        if (current.revision !== expectedRevision) throw new InjectSourceError("revision_conflict", 409, current);
        const file = FILES.find((item) => item.id === id)!;
        await this.atomicSave(file.path, content, expectedRevision);
        return this.get(id);
      }
      return this.overrides.transaction(() => {
        const current = this.getDbSource(summary);
        if (current.revision !== expectedRevision) throw new InjectSourceError("revision_conflict", 409, current);
        const definition = majorInjectDefinition(id);
        if (definition) {
          const errors = validateMajorInjectTemplate(definition, content);
          if (errors.unknown.length || errors.missing.length) throw new InjectSourceError("invalid_placeholders", 400, errors);
          this.overrides.set(id, content);
        } else if (summary.target_kind === "manual") {
          const kind = MANUAL_IDS.find(([key]) => id === `delegation.manual.${key}`)![1];
          this.manuals.upsert(kind, content);
        } else {
          const templateId = id.slice("delegation.template.".length);
          const template = this.templates.findTemplate(templateId)!;
          const known = new Set(parseInputSchema(template.input_schema).map((item) => item.name));
          const found = [...content.matchAll(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)(?::[^}]*)?\}/g)].map((match) => match[1]);
          const unknown = [...new Set(found.filter((name) => !known.has(name)))];
          if (unknown.length) throw new InjectSourceError("invalid_placeholders", 400, { unknown, missing: [] });
          this.templates.updateTemplate(templateId, { prompt_template: content });
        }
        return this.getDbSource(summary);
      });
    });
  }

  async restore(id: string, expectedRevision: string): Promise<InjectSource> {
    return this.serial(id, async () => {
      const summary = this.summary(id);
      if (!summary) throw new InjectSourceError("unknown_target", 404);
      if (!summary.restorable) throw new InjectSourceError("restore_unavailable", 400);
      return this.overrides.transaction(() => {
        const current = this.getDbSource(summary);
        if (current.revision !== expectedRevision) throw new InjectSourceError("revision_conflict", 409, current);
        if (summary.target_kind === "builder") this.overrides.delete(id);
        else {
          const kind = MANUAL_IDS.find(([key]) => id === `delegation.manual.${key}`)![1];
          this.manuals.upsert(kind, DEFAULT_MANUALS[kind]);
        }
        return this.getDbSource(summary);
      });
    });
  }

  private async safeFilePath(relativePath: string): Promise<string> {
    const root = await realpath(PROJECT_ROOT);
    const path = resolve(root, relativePath);
    const rel = relative(root, path);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new InjectSourceError("invalid_path", 400);
    const parent = await realpath(dirname(path));
    if (parent !== dirname(path)) throw new InjectSourceError("linked_path", 400);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path) throw new InjectSourceError("linked_path", 400);
    return path;
  }

  private async atomicSave(relativePath: string, content: string, expectedRevision: string): Promise<void> {
    const path = await this.safeFilePath(relativePath);
    const lockPath = `${path}.cc-inject.lock`;
    const deadline = Date.now() + 2_000;
    let lock: Awaited<ReturnType<typeof open>>;
    while (true) {
      try { lock = await open(lockPath, "wx"); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline) throw new InjectSourceError("target_busy", 409, await this.get(FILES.find((item) => item.path === relativePath)!.id));
        await delay(50);
      }
    }
    const temp = join(dirname(path), `.cc-inject-${randomUUID()}.tmp`);
    try {
      await this.safeFilePath(relativePath);
      const before = await readFile(path, "utf8");
      if (revision(before) !== expectedRevision) throw new InjectSourceError("revision_conflict", 409, await this.get(FILES.find((item) => item.path === relativePath)!.id));
      await writeFile(temp, content, { encoding: "utf8", flag: "wx" });
      await this.safeFilePath(relativePath);
      const latest = await readFile(path, "utf8");
      if (revision(latest) !== expectedRevision) {
        throw new InjectSourceError("revision_conflict", 409,
          await this.get(FILES.find((item) => item.path === relativePath)!.id));
      }
      await rename(temp, path);
    } finally {
      await unlink(temp).catch(() => undefined);
      await lock.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }

  private async serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.inFlight.get(id) ?? Promise.resolve();
    const running = previous.catch(() => undefined).then(work);
    this.inFlight.set(id, running);
    try { return await running; }
    finally { if (this.inFlight.get(id) === running) this.inFlight.delete(id); }
  }
}
