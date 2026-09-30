/**
 * admin spawn (`POST /v1/admin/spawn-session`) の要求本体と、 部署の起動値の
 * 相互変換。 要求本体の形 (template / provider / model / reasoning_effort /
 * options / project / cwd) を知っているのはここだけにして、 既定値の判断
 * (launch-defaults.ts) を HTTP の形から切り離す。
 *
 * @implements spec/feature/departments.md §5
 * @implements SPEC-DEPT-LAUNCH
 */

import type { DepartmentLaunchRequest, ResolvedDepartmentLaunch } from "./launch-defaults.js";

/** runtime options のうち effort を表すキー。 どれか 1 つでも明示されていれば既定を入れない。 */
const EFFORT_OPTION_KEYS = ["effort", "reasoning_effort", "model_reasoning_effort"] as const;

export function readSpawnLaunchRequest(body: Record<string, unknown>): DepartmentLaunchRequest {
  const options = isPlainObject(body.options) ? body.options : {};
  const optionEffort = EFFORT_OPTION_KEYS.map((key) => text(options[key])).find((value) => value !== null) ?? null;
  return {
    template: text(body.template),
    provider: text(body.provider),
    model: text(body.model),
    reasoning_effort: text(body.reasoning_effort) ?? optionEffort,
    project: text(body.project),
    cwd: text(body.cwd),
  };
}

/**
 * 部署の起動値を要求本体へ書き戻す。 要求が明示していた値は launch にそのまま
 * 入っているので、 ここでは既定値で埋まった項目だけが変わる。
 */
export function applySpawnLaunch(
  body: Record<string, unknown>,
  launch: ResolvedDepartmentLaunch,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...body };
  assign(next, "template", launch.template);
  assign(next, "provider", launch.provider);
  assign(next, "model", launch.model);
  assign(next, "project", launch.project);
  assign(next, "cwd", launch.cwd);
  if (launch.reasoning_effort) {
    const options = isPlainObject(body.options) ? body.options : {};
    const explicit = text(body.reasoning_effort) !== null
      || EFFORT_OPTION_KEYS.some((key) => text(options[key]) !== null);
    if (!explicit) {
      // テンプレート経路は options、 prompt 注入経路は overrides (body.reasoning_effort)
      // から effort を読むため両方へ入れる。
      next.reasoning_effort = launch.reasoning_effort;
      next.options = { ...options, reasoning_effort: launch.reasoning_effort };
    }
  }
  return next;
}

function assign(target: Record<string, unknown>, key: string, value: string | null): void {
  if (value === null) delete target[key];
  else target[key] = value;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
