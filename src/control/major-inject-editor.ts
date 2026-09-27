import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath, rename, writeFile, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { parseInputSchema, type DelegationRepo } from "../db/delegation-repo.js";
import type { InjectManualsRepo, InjectManualKind } from "../db/inject-manuals-repo.js";
import type { MajorInjectRepo } from "../db/major-inject-repo.js";
import type { InjectHistoryVersion } from "../db/major-inject-history-repo.js";
import { DEFAULT_MANUALS } from "./inject-manual-seed.js";
import { migrateKnownContextFragment } from "./inject-context-migration.js";
import { LEGACY_ANATOMIA_SEED_CALL_NAMES, plannedSeedTemplates, stripKnownSeedAnatomiaBlock,
  type SeedIdentifiers } from "../delegation/seed.js";
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
  scope_kind?: "basic" | "extension";
  apply_when?: string;
}
export interface InjectSource extends InjectSourceSummary {
  content: string;
  revision: string;
  updated_at?: number;
  history_version_id?: number | null;
}

export interface InjectHistoryPage {
  versions: Array<Omit<InjectHistoryVersion, "content">>;
  next_before: number | null;
  pending: { operation_id: string; status: string; created_at: number; failure_reason: string | null } | null;
}

export interface InjectChangeOptions {
  actor?: "system";
  changeKind?: "context_migration" | "restore_version";
  expectedVersionId?: number | null;
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
    private readonly fileRoot: string = PROJECT_ROOT,
  ) { this.migrateKnownOverrides(); }

  private migrateKnownOverrides(): void {
    for (const id of ["session.work_policy", "session.workflow.normal", "session.process_guidance", "delegation.persona_context"]) {
      this.overrides.transaction(() => {
        const row = this.overrides.get(id);
        if (!row) return;
        const after = migrateKnownContextFragment(id, row.content);
        if (after === null || after === row.content) return;
        const parent = this.captureCurrent(id, row.content);
        this.overrides.set(id, after);
        this.overrides.history.append({ target_id: id, parent_version_id: parent.version_id,
          revision: revision(after), content: after, actor: "system", change_kind: "context_migration",
          created_at: Date.now(), operation_id: null });
      });
    }
  }

  /** Called immediately before boot seed, while old seed-owned template bodies still exist. */
  migrateKnownSeedTemplates(identifiers: SeedIdentifiers): void {
    for (const planned of plannedSeedTemplates(identifiers)) {
      this.overrides.transaction(() => {
        const row = this.templates.findTemplateByCallName(planned.call_name);
        if (!row || this.templates.isTemplatePromptEdited(row.id)) return;
        const id = `delegation.template.${row.id}`;
        if (row.prompt_template === planned.prompt_template) return;
        const after = LEGACY_ANATOMIA_SEED_CALL_NAMES.has(planned.call_name)
          ? stripKnownSeedAnatomiaBlock(row.prompt_template) : null;
        if (after !== planned.prompt_template) {
          // An unrecognized body may be a manual edit made before edit markers existed.
          // Capture it before seed runs, then prevent seed from replacing it.
          this.captureCurrent(id, row.prompt_template);
          this.templates.markTemplatePromptEdited(row.id);
          return;
        }
        const parent = this.captureCurrent(id, row.prompt_template);
        this.templates.updateTemplate(row.id, { prompt_template: after }, { markPromptEdited: false });
        this.overrides.history.append({ target_id: id, parent_version_id: parent.version_id,
          revision: revision(after), content: after, actor: "system", change_kind: "context_migration",
          created_at: Date.now(), operation_id: null });
      });
    }
  }

  resolve = (id: string): string | null => {
    if (!majorInjectDefinition(id)) return null;
    return this.overrides.get(id)?.content ?? null;
  };

  list(): InjectSourceSummary[] {
    return [
      ...MAJOR_INJECT_DEFINITIONS.map((definition): InjectSourceSummary => ({
        id: definition.id, label: definition.label, workflow: definition.workflow, case: definition.case,
        target_kind: "builder", origin: "builtin_override", apply_scope: definition.apply_scope,
        scope_kind: definition.scope_kind ?? "basic", apply_when: definition.apply_when,
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
    return { ...summary, content, revision: revision(content),
      history_version_id: this.overrides.history.latest(id)?.version_id ?? null };
  }

  private getDbSource(summary: InjectSourceSummary): InjectSource {
    const id = summary.id;
    if (summary.target_kind === "builder") {
      const definition = majorInjectDefinition(id)!;
      const row = this.overrides.get(id);
      const content = row?.content ?? definition.default_content;
      return { ...summary, content, revision: revision(content), updated_at: row?.updated_at,
        history_version_id: this.overrides.history.latest(id)?.version_id ?? null };
    }
    if (summary.target_kind === "manual") {
      const kind = MANUAL_IDS.find(([key]) => id === `delegation.manual.${key}`)![1];
      const row = this.manuals.get(kind);
      const content = row?.content ?? DEFAULT_MANUALS[kind];
      return { ...summary, content, revision: revision(content), updated_at: row?.updated_at,
        history_version_id: this.overrides.history.latest(id)?.version_id ?? null };
    }
    if (summary.target_kind === "template") {
      const row = this.templates.findTemplate(id.slice("delegation.template.".length));
      if (!row) throw new InjectSourceError("unknown_target", 404);
      return { ...summary, content: row.prompt_template, revision: revision(row.prompt_template), updated_at: row.updated_at,
        history_version_id: this.overrides.history.latest(id)?.version_id ?? null };
    }
    throw new InjectSourceError("unknown_target", 404);
  }

  private summary(id: string): InjectSourceSummary | null {
    const definition = majorInjectDefinition(id);
    if (definition) return {
      id, label: definition.label, workflow: definition.workflow, case: definition.case,
      target_kind: "builder", origin: "builtin_override", apply_scope: definition.apply_scope,
      scope_kind: definition.scope_kind ?? "basic", apply_when: definition.apply_when,
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

  private captureCurrent(id: string, content: string): InjectHistoryVersion {
    const history = this.overrides.history;
    const currentRevision = revision(content);
    const latest = history.latest(id);
    if (!latest) return history.ensureBaseline(id, content, currentRevision);
    if (latest.revision === currentRevision && latest.content === content) return latest;
    return history.append({ target_id: id, parent_version_id: latest.version_id, revision: currentRevision,
      content, actor: "unknown", change_kind: "external_import", created_at: Date.now(), operation_id: null });
  }

  private checkVersion(expected: number | null | undefined, current: InjectHistoryVersion, source: InjectSource): void {
    if (expected !== undefined && expected !== null && current.version_id !== expected) {
      throw new InjectSourceError("revision_conflict", 409, source);
    }
  }

  async history(id: string, before: number | null = null, limit = 20): Promise<InjectHistoryPage> {
    return this.serial(id, async () => {
      const summary = this.summary(id);
      if (!summary) throw new InjectSourceError("unknown_target", 404);
      if (summary.target_kind === "file") await this.reconcileFile(id);
      else this.overrides.transaction(() => this.captureCurrent(id, this.getDbSource(summary).content));
      const bounded = Math.min(50, Math.max(1, limit));
      const versions = this.overrides.history.list(id, before, bounded);
      const pending = this.overrides.history.pending(id);
      return { versions: versions.map(({ content: _content, ...version }) => version),
        next_before: versions.length === bounded ? versions.at(-1)!.version_id : null,
        pending: pending ? { operation_id: pending.operation_id, status: pending.status,
          created_at: pending.created_at, failure_reason: pending.failure_reason } : null };
    });
  }

  async historyVersion(id: string, versionId: number): Promise<{ version: InjectHistoryVersion; parent: InjectHistoryVersion | null }> {
    await this.history(id, null, 1);
    const version = this.overrides.history.version(id, versionId);
    if (!version) throw new InjectSourceError("unknown_version", 404);
    return { version, parent: version.parent_version_id === null ? null
      : this.overrides.history.version(id, version.parent_version_id) };
  }

  async put(id: string, content: string, expectedRevision: string, options: InjectChangeOptions = {}): Promise<InjectSource> {
    return this.serial(id, async () => {
      if (Buffer.byteLength(content, "utf8") > MAX_BYTES) throw new InjectSourceError("content_too_large", 400, { max_bytes: MAX_BYTES });
      const summary = this.summary(id);
      if (!summary) throw new InjectSourceError("unknown_target", 404);
      if (summary.target_kind === "file") {
        await this.reconcileFile(id);
        if (this.overrides.history.pending(id)) throw new InjectSourceError("file_outcome_unknown", 409, await this.get(id));
        const current = await this.get(id);
        if (current.revision !== expectedRevision) throw new InjectSourceError("revision_conflict", 409, current);
        const parent = this.overrides.history.transaction(() => this.captureCurrent(id, current.content));
        this.checkVersion(options.expectedVersionId, parent, { ...current, history_version_id: parent.version_id });
        if (content === current.content && options.changeKind !== "restore_version") {
          return { ...current, history_version_id: parent.version_id };
        }
        const file = FILES.find((item) => item.id === id)!;
        const operationId = randomUUID();
        await this.atomicSave(file.path, content, expectedRevision, () => {
          this.overrides.history.transaction(() => {
            const latest = this.overrides.history.latest(id);
            if (latest?.version_id !== parent.version_id) throw new InjectSourceError("revision_conflict", 409, current);
            this.overrides.history.addOperation({ operation_id: operationId, target_id: id,
              parent_version_id: parent.version_id, expected_revision: expectedRevision,
              desired_revision: revision(content), content, actor: options.actor ?? "unknown",
              change_kind: options.changeKind ?? "edit", created_at: Date.now() });
          });
        });
        this.overrides.history.transaction(() => {
          this.overrides.history.append({ target_id: id, parent_version_id: parent.version_id,
            revision: revision(content), content, actor: options.actor ?? "unknown",
            change_kind: options.changeKind ?? "edit", created_at: Date.now(), operation_id: operationId });
          this.overrides.history.setOperationStatus(operationId, "applied");
        });
        return this.get(id);
      }
      const outcome = this.overrides.transaction(() => {
        const current = this.getDbSource(summary);
        const parent = this.captureCurrent(id, current.content);
        const observed = { ...current, history_version_id: parent.version_id };
        if (current.revision !== expectedRevision
          || (options.expectedVersionId != null && parent.version_id !== options.expectedVersionId)) {
          return { conflict: observed };
        }
        if (content === current.content && options.changeKind !== "restore_version") {
          return { source: observed };
        }
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
        this.overrides.history.append({ target_id: id, parent_version_id: parent.version_id,
          revision: revision(content), content, actor: options.actor ?? "unknown",
          change_kind: options.changeKind ?? "edit", created_at: Date.now(), operation_id: null });
        return { source: this.getDbSource(summary) };
      });
      if ("conflict" in outcome) throw new InjectSourceError("revision_conflict", 409, outcome.conflict);
      return outcome.source;
    });
  }

  async restore(id: string, expectedRevision: string, expectedVersionId?: number | null): Promise<InjectSource> {
    return this.serial(id, async () => {
      const summary = this.summary(id);
      if (!summary) throw new InjectSourceError("unknown_target", 404);
      if (!summary.restorable) throw new InjectSourceError("restore_unavailable", 400);
      const outcome = this.overrides.transaction(() => {
        const current = this.getDbSource(summary);
        const parent = this.captureCurrent(id, current.content);
        const observed = { ...current, history_version_id: parent.version_id };
        if (current.revision !== expectedRevision
          || (expectedVersionId != null && parent.version_id !== expectedVersionId)) {
          return { conflict: observed };
        }
        const defaultContent = summary.target_kind === "builder"
          ? majorInjectDefinition(id)!.default_content
          : DEFAULT_MANUALS[MANUAL_IDS.find(([key]) => id === `delegation.manual.${key}`)![1]];
        if (summary.target_kind === "builder") this.overrides.delete(id);
        else {
          const kind = MANUAL_IDS.find(([key]) => id === `delegation.manual.${key}`)![1];
          this.manuals.upsert(kind, DEFAULT_MANUALS[kind]);
        }
        this.overrides.history.append({ target_id: id, parent_version_id: parent.version_id,
          revision: revision(defaultContent), content: defaultContent, actor: "unknown",
          change_kind: "restore_default", created_at: Date.now(), operation_id: null });
        return { source: this.getDbSource(summary) };
      });
      if ("conflict" in outcome) throw new InjectSourceError("revision_conflict", 409, outcome.conflict);
      return outcome.source;
    });
  }

  async restoreVersion(id: string, versionId: number, expectedRevision: string,
    expectedVersionId?: number | null): Promise<InjectSource> {
    const version = (await this.historyVersion(id, versionId)).version;
    return this.put(id, version.content, expectedRevision, { expectedVersionId, changeKind: "restore_version" });
  }

  async resolveFileOutcome(id: string, operationId: string, expectedRevision: string,
    expectedVersionId?: number | null): Promise<InjectSource> {
    return this.serial(id, async () => {
      const summary = this.summary(id);
      if (!summary) throw new InjectSourceError("unknown_target", 404);
      if (summary.target_kind !== "file") throw new InjectSourceError("file_target_required", 400);
      const file = FILES.find((item) => item.id === id)!;
      const path = await this.safeFilePath(file.path);
      const lockPath = `${path}.cc-inject.lock`;
      await this.clearStaleLock(lockPath, id);
      let lock: Awaited<ReturnType<typeof open>>;
      try { lock = await open(lockPath, "wx"); }
      catch { throw new InjectSourceError("target_busy", 409, await this.get(id)); }
      try {
        await lock.writeFile(JSON.stringify({ pid: process.pid, created_at: Date.now() }));
        const pending = this.overrides.history.pending(id);
        if (!pending || pending.operation_id !== operationId) {
          throw new InjectSourceError("operation_not_pending", 409, await this.get(id));
        }
        const current = await this.get(id);
        const outcome = this.overrides.history.transaction(() => {
          const parent = this.captureCurrent(id, current.content);
          const observed = { ...current, history_version_id: parent.version_id };
          if (current.revision !== expectedRevision
            || (expectedVersionId != null && parent.version_id !== expectedVersionId)) {
            return { conflict: observed };
          }
          this.overrides.history.append({ target_id: id, parent_version_id: parent.version_id,
            revision: current.revision, content: current.content, actor: "unknown",
            change_kind: "resolve_file_outcome", created_at: Date.now(), operation_id: null });
          this.overrides.history.setOperationStatus(operationId, "resolved", "current_file_accepted_by_admin");
          return { conflict: null };
        });
        if (outcome.conflict) throw new InjectSourceError("revision_conflict", 409, outcome.conflict);
        return this.get(id);
      } finally {
        await lock.close();
        await unlink(lockPath).catch(() => undefined);
      }
    });
  }

  private async safeFilePath(relativePath: string): Promise<string> {
    const root = await realpath(this.fileRoot);
    const path = resolve(root, relativePath);
    const rel = relative(root, path);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new InjectSourceError("invalid_path", 400);
    const parent = await realpath(dirname(path));
    if (parent !== dirname(path)) throw new InjectSourceError("linked_path", 400);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path) throw new InjectSourceError("linked_path", 400);
    return path;
  }

  private async reconcileFile(id: string): Promise<void> {
    const file = FILES.find((item) => item.id === id)!;
    const path = await this.safeFilePath(file.path);
    const content = await readFile(path, "utf8");
    const pending = this.overrides.history.pending(id);
    if (!pending) {
      this.overrides.history.transaction(() => this.captureCurrent(id, content));
      return;
    }
    // A live writer can run longer than the grace period. Never classify its operation
    // from an intermediate file observation; dead/legacy locks remain for explicit recovery.
    try {
      const lockPath = `${path}.cc-inject.lock`;
      const lock = await lstat(lockPath);
      if (Date.now() - lock.mtimeMs < 30_000) return;
      let owner: { pid?: number } = {};
      try { owner = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number }; }
      catch { /* Legacy lock without owner metadata. */ }
      if (Number.isSafeInteger(owner.pid) && owner.pid! > 0) {
        try { process.kill(owner.pid!, 0); return; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return; }
      } else if (Date.now() - lock.mtimeMs < 5 * 60_000) return;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.overrides.history.transaction(() => {
      const latest = this.overrides.history.latest(id);
      if (latest?.operation_id === pending.operation_id
        && latest.parent_version_id === pending.parent_version_id
        && latest.revision === pending.desired_revision
        && latest.content === pending.content) {
        this.overrides.history.setOperationStatus(pending.operation_id, "applied");
        this.captureCurrent(id, content);
      } else {
        // Neither old nor desired bytes prove whether rename ran before a later external write.
        this.overrides.history.setOperationStatus(pending.operation_id, "uncertain", "file_outcome_unconfirmed");
        this.captureCurrent(id, content);
      }
    });
  }

  private async clearStaleLock(lockPath: string, id: string): Promise<void> {
    let stat: Awaited<ReturnType<typeof lstat>>;
    try { stat = await lstat(lockPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let owner: { pid?: number } = {};
    let content = "";
    try { content = await readFile(lockPath, "utf8"); owner = JSON.parse(content) as { pid?: number }; }
    catch { /* Older lock files had no owner metadata. */ }
    let alive = false;
    if (Number.isSafeInteger(owner.pid) && owner.pid! > 0) {
      try { process.kill(owner.pid!, 0); alive = true; }
      catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    } else alive = Date.now() - stat.mtimeMs < 5 * 60_000;
    if (alive) throw new InjectSourceError("target_busy", 409, await this.get(id));
    // A different writer may have replaced the stale lock while we inspected it.
    // This is a best-effort identity guard, not a filesystem-wide atomic CAS.
    let latest: Awaited<ReturnType<typeof lstat>>;
    let latestContent: string;
    try { latest = await lstat(lockPath); latestContent = await readFile(lockPath, "utf8"); }
    catch { throw new InjectSourceError("target_busy", 409, await this.get(id)); }
    if (latest.dev !== stat.dev || latest.ino !== stat.ino || latest.mtimeMs !== stat.mtimeMs
      || latest.size !== stat.size || latestContent !== content) {
      throw new InjectSourceError("target_busy", 409, await this.get(id));
    }
    await unlink(lockPath);
  }

  private async atomicSave(relativePath: string, content: string, expectedRevision: string,
    prepared: () => void): Promise<void> {
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
      await lock.writeFile(JSON.stringify({ pid: process.pid, created_at: Date.now() }));
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
      prepared();
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
