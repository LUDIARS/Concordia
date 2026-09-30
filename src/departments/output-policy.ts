/**
 * 部署の出力方針 (思考・状態カード・セッション情報表示・コスト報告) を、
 * 全体設定と合わせて「出すか」に解決する。
 *
 * inherit は全体設定に従う。 部署に属さないセッションも全体設定に従う (従来どおり)。
 *
 * @implements spec/feature/departments.md §9.4
 * @implements SPEC-DEPT-OUTPUT
 */

import { parseDepartmentSettings, type DepartmentOutputItem, type DepartmentOutputMode } from "./settings.js";

export function isOutputEnabled(mode: DepartmentOutputMode, globalEnabled: boolean): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  return globalEnabled;
}

export interface SessionOutputPorts {
  /** セッションの所属部署。 セッションが無い・未配属は null。 */
  sessionDepartmentId(sessionId: string): string | null;
  /** 部署の settings_json。 部署が無ければ null。 */
  departmentSettingsJson(departmentId: string): string | null;
  /** 保存済み設定が壊れていたときの通知 (全体設定へ倒したことを観測可能にする)。 */
  onBrokenSettings?(departmentId: string): void;
}

export function resolveSessionOutputMode(
  ports: SessionOutputPorts,
  sessionId: string,
  item: DepartmentOutputItem,
): DepartmentOutputMode {
  const departmentId = ports.sessionDepartmentId(sessionId);
  if (!departmentId) return "inherit";
  const settingsJson = ports.departmentSettingsJson(departmentId);
  if (settingsJson === null) return "inherit";
  try {
    return parseDepartmentSettings(settingsJson).output[item];
  } catch {
    // 出力方針は表示の出し分けだけで、 起動や権限には効かない。 壊れた行で中継を
    // 止めるより全体設定に従わせ、 その事実を通知側で記録する。
    ports.onBrokenSettings?.(departmentId);
    return "inherit";
  }
}
