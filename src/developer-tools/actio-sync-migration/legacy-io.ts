/** M5 の本番の I/O を組み立てる (tools/actio-sync-migration.mjs から使う)。 */
import { legacyCommitTimes } from "./legacy-activity.js";
import { legacyTaskCreator, migrationActioClient, migrationActioTransport, readMigrationBindings } from "./legacy-actio.js";
import { readLegacyTaskContent } from "./legacy-documents.js";
import type { LegacyMigrationIo } from "./legacy-ports.js";
import { openLegacyState } from "./legacy-state.js";

export function createLegacyMigrationIo(actioUrl: string, env: Record<string, string | undefined>): LegacyMigrationIo {
  let transport: ReturnType<typeof migrationActioTransport> | null = null;
  const actio = () => (transport ??= migrationActioTransport(actioUrl, env));
  let create: ReturnType<typeof legacyTaskCreator> | null = null;
  return {
    commitTimes: (rows) => legacyCommitTimes(rows),
    bindings: (projects) => readMigrationBindings(actio(), projects, env),
    readContent: readLegacyTaskContent,
    createTask: (binding, entry, content) => (create ??= legacyTaskCreator(migrationActioClient(actio())))(binding, entry, content),
    openState: openLegacyState,
  };
}
