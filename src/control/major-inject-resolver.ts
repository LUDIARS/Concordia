import { majorInjectDefinition, renderMajorInjectTemplate } from "./major-inject-catalog.js";
import { migrateKnownContextFragment } from "./inject-context-migration.js";

/** Injected by composition roots; builders never access database state globally. */
export type MajorInjectResolver = (id: string) => string | null;

export function resolveMajorInjectContent(id: string, resolver?: MajorInjectResolver): string {
  const definition = majorInjectDefinition(id);
  if (!definition) throw new Error(`unknown_major_inject_target: ${id}`);
  const override = resolver?.(id);
  return override === null || override === undefined ? definition.default_content
    : migrateKnownContextFragment(id, override) ?? override;
}

export function resolveMajorInjectText(
  id: string,
  resolver?: MajorInjectResolver,
  values: Readonly<Record<string, string>> = {},
): string {
  return renderMajorInjectTemplate(resolveMajorInjectContent(id, resolver), values);
}
