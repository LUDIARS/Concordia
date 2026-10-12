/**
 * M5 の Actio 側。Cc 本体と同じ部品をそのまま使う:
 * - ActioTransport: 毎回 /api/auth/me で相手の身元を確かめ、チームの権限も確かめる。
 * - createActioBindingReader: 明示の binding と、repo のプロジェクトコード × Actio の登録 (GET /api/projects/cc)。
 * - ActioWorkflowClient.create (reuseExisting): 作業単位のキーで一度だけ作り、同じキーの task があれば再利用する。
 * 接続先は --actio-url で受け取る (ポートは excubitor.catalog.yaml が正本)。Actio はローカル (loopback) だけを相手にする。
 */
import type { ExcubitorService } from "../../excubitor/client.js";
import { readActioBindings, type ActioBinding } from "../../taskflow/actio-binding.js";
import { createActioBindingReader } from "../../taskflow/actio-project-binding.js";
import { listLocalActioProjects } from "../../taskflow/actio-projects.js";
import { ActioWorkflowClient } from "../../taskflow/actio-task-client.js";
import { ActioTransport } from "../../taskflow/actio-transport.js";
import type { LegacyTaskContent } from "../../taskflow/sync-migration-legacy-describe.js";
import type { LegacyCreatePlan } from "../../taskflow/sync-migration-legacy.js";
import type { MigrationProject } from "../../taskflow/sync-migration-types.js";
import type { TaskStatus } from "../../taskflow/types.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** --actio-url のポートを catalog の宣言値として渡す (ActioTransport は 127.0.0.1 にしか繋がない)。 */
export function migrationActioTransport(actioUrl: string, env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): ActioTransport {
  const url = new URL(actioUrl);
  const port = Number(url.port);
  if (!LOOPBACK.has(url.hostname) || !Number.isInteger(port) || port < 1) {
    throw new Error("--actio-url must be a loopback URL with an explicit port (read it from excubitor.catalog.yaml)");
  }
  const catalog = { findService: async () => ({ state: "running", catalog_snapshot: { port } }) as unknown as ExcubitorService };
  return new ActioTransport(catalog, (name) => env[name], fetchImpl);
}

export async function readMigrationBindings(
  transport: ActioTransport, projects: readonly MigrationProject[], env: Record<string, string | undefined>,
): Promise<readonly ActioBinding[]> {
  const repositories = projects.filter((project) => project.repo_path)
    .map((project) => ({ code: project.code, project: project.project, repo_path: project.repo_path! }));
  return createActioBindingReader({
    configured: () => readActioBindings(env as NodeJS.ProcessEnv),
    repositories: () => repositories,
    registered: () => listLocalActioProjects(transport),
  })();
}

export function legacyTaskCreator(client: Pick<ActioWorkflowClient, "create">) {
  return async (binding: ActioBinding, entry: LegacyCreatePlan, content: LegacyTaskContent): Promise<{ id: string; existed: boolean }> => {
    const { task, existed } = await client.create(binding, {
      sourceRef: entry.source_ref, title: entry.title ?? content.title, body: content.body, kind: content.kind,
      memoryLinks: content.memoryLinks, status: entry.status as TaskStatus, reuseExisting: true,
    });
    return { id: task.id, existed };
  };
}

export function migrationActioClient(transport: ActioTransport): ActioWorkflowClient {
  return new ActioWorkflowClient(transport);
}
