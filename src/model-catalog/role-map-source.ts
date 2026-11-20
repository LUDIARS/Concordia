/**
 * DB (役割スナップショット + モデルカタログ) から、 その時点の role map を引く口。
 * 委託 spawn のたびに都度読むので、 カタログ・自動更新の変更は再起動なしで効く。
 *
 * @implements CC-MODEL-ROLE-MAP MRM-TPL-01
 */
import type Database from "better-sqlite3";
import { ModelCatalogRepo } from "../db/model-catalog-repo.js";
import { ModelRoleRepo } from "../db/model-role-repo.js";
import { buildRoleMap, type RoleMap } from "./role-map.js";

export function createRoleMapSource(db: Database.Database): () => RoleMap["roles"] {
  const roles = new ModelRoleRepo(db);
  const catalog = new ModelCatalogRepo(db);
  return () => buildRoleMap({ roles: roles.list(), catalog: catalog.list(), nowMs: Date.now() }).roles;
}
