/**
 * service spawn 時の env 注入解決.
 *
 * Excubitor 由来の Infisical 統合は廃止: 各サービスが自前で起動時に Infisical
 * fetch する設計に変更. このモジュールは API 互換のため残してあるが、 実体は
 * 常に空 env を返す.  (2026-05-17 Concordia 統合)
 */
import { type Service } from '../catalog/loader.js';

export async function resolveInjectEnv(_svc: Service): Promise<Record<string, string>> {
  return {};
}
