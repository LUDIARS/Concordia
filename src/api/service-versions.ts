/**
 * /v1/service-versions — サービスの版を Revisor 経由で答える (読み取り専用)。
 *
 *   GET /v1/service-versions?service=Rv&service=Concordia
 *     → 明示指定したサービスの版。 LUDIARS のプロジェクトコード / プロジェクト名 /
 *       Excubitor のサービス code のどれで指定してもよい。
 *   GET /v1/service-versions?cwd=<絶対パス>
 *     → 明示指定なし。 **いまの関連プロジェクト** の版を返す。
 *
 * 応答: { scope, requested, versions:[{ requested, found, services:[...] }] }
 *
 * 版そのものは組み立てない — Revisor が正本 (`revisor-versions-client.ts`)。 Cc の仕事は
 * 「誰に聞くか」 を Cc だけが持つ registry (project_codes) で決めることに閉じる。
 *
 * 認証は loopback 想定で無し (他 /v1 と同じ)。
 */

import { Hono } from "hono";
import type { ServiceVersionReader } from "../service-versions/revisor-versions-client.js";
import {
  expandSelectors,
  resolveCurrentProject,
  UnknownProjectError,
  type ProjectCodeLookup,
  type RepoContext,
} from "../service-versions/service-selectors.js";

export interface ServiceVersionsApiDeps {
  /** 略称・現在地からプロジェクトを引く registry。 */
  projectCodes: ProjectCodeLookup;
  /** Revisor の版照会。 未注入なら 503 (誤った既定値を返さない)。 */
  versions?: ServiceVersionReader;
  /** cwd から repository を同定する。 worktree でも origin で本体に寄せられる。 */
  inspectRepo: (cwd: string) => Promise<RepoContext>;
  log?: { warn: (message: string) => void };
}

function requestedServices(values: string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value !== "");
}

export function serviceVersionsRouter(deps: ServiceVersionsApiDeps): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    if (!deps.versions) {
      return c.json({ error: "revisor_unavailable", detail: "Revisor への版照会が未設定です。" }, 503);
    }
    const explicit = requestedServices(c.req.queries("service") ?? []);
    let services: string[];
    let scope: "explicit" | "current_project";
    if (explicit.length > 0) {
      services = expandSelectors(deps.projectCodes, explicit);
      scope = "explicit";
    } else {
      // 明示指定が無いときだけ現在地を見る。 cwd が無ければ何を聞きたいのか決まらない
      // ので、 全サービスへ広げずに «何を» が要ると伝えて止める。
      const cwd = (c.req.query("cwd") ?? "").trim();
      if (!cwd) {
        return c.json({
          error: "service_or_cwd_required",
          detail: "service を指定するか、 現在の作業ディレクトリを cwd で渡してください。",
        }, 400);
      }
      try {
        const context = await deps.inspectRepo(cwd);
        services = [resolveCurrentProject(deps.projectCodes, context)];
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return c.json({
          error: error instanceof UnknownProjectError ? "project_not_registered" : "invalid_cwd",
          detail,
        }, 400);
      }
      scope = "current_project";
    }

    try {
      return c.json({ scope, requested: services, versions: await deps.versions.versions(services) });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      deps.log?.warn(`service version lookup failed: ${detail}`);
      return c.json({ error: "revisor_request_failed", detail }, 502);
    }
  });

  return app;
}
