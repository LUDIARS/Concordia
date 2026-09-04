import { Hono } from "hono";
import { resolveModules, type WiringObservation } from "../modules/resolve.js";
import { resolveModuleMode } from "../modules/runtime-modes.js";

/**
 * `GET /v1/modules` — 各モジュールの解決済み mode・担当プロセス・health・degraded_note を
 * 1 コールで返す。
 *
 * 「いま何が止まっているのか」を知るのに、環境変数と bootstrap の分岐を読むしかない
 * 状態だった。off にしたときに何が生き残るかも、宣言として持たないと運用が判断できない。
 *
 * 読み取り専用。ON/OFF の操作面 (spec §4) は別で、lifecycle は Excubitor が持つ。
 *
 * @implements spec/feature/module-manifest.md §2
 */
export interface ModulesApiDeps {
  /**
   * 実際に backend 内で起動したモジュール名。bootstrap が渡す。
   * 台帳と食い違えば mismatches に出る。
   */
  wiring: () => WiringObservation;
  env?: NodeJS.ProcessEnv;
}

export function modulesRouter(deps: ModulesApiDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const modules = resolveModules(
      (entry) => resolveModuleMode(entry, deps.env),
      deps.wiring(),
    );
    return c.json({
      modules: modules.map((module) => ({
        name: module.name,
        domain: module.domain,
        mode: module.mode,
        mode_env: module.modeEnv,
        modes: module.modes,
        excubitor_code: module.excubitorCode,
        health_path: module.healthPath,
        degraded_note: module.degradedNote,
        // 空配列で返す。 キーの有無で分岐させると、 呼び出し側が
        // 「不一致が無い」と「まだ調べていない」を取り違える。
        mismatches: module.mismatches,
      })),
    });
  });

  return app;
}
