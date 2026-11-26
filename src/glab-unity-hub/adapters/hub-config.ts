/**
 * GLab-UnityHub の設定 (契約 v1 §2 / §4)。
 *
 * 秘密でない設定は concordia.config.json の `glabUnityHub` 節に置く (例は
 * concordia.config.example.json)。 運用で切り替える値だけ env で上書きできる:
 *
 * - `GLAB_UNITY_HUB_GUILD_ID` — GLab の Discord サーバー (guild) id
 * - `GLAB_UNITY_HUB_PORT` — 待受ポート (Excubitor catalog が正本、 catalog の env で渡す)
 * - `GLAB_UNITY_HUB_ALLOWED_COUNTRIES` — 許可国 (既定 JP)
 * - `GLAB_UNITY_HUB_GEO_POLICY` — `monitor` | `block` (既定 block、 neco 裁定)
 * - `GLAB_UNITY_HUB_DB_PATH` — モジュール所有の SQLite (既定は Concordia DB と同じ場所の glab-unity-hub.sqlite)
 *
 * 鍵 (Discord Bot token / Notion / gh) はここに置かない。
 *
 * @implements spec/feature/glab-unity-hub.md §6 (GUH-CONFIG)
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { parseAllowedCountries, parseGeoPolicy, type GeoPolicy } from "../domain/geo-policy.js";
import type { NotionBoardConfig } from "../domain/notion-board.js";
import type { SpecRepoBinding } from "../domain/spec-draft.js";

const snowflake = z.string().regex(/^\d{5,25}$/);
const repo = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const code = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/);

const BoardSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  dataSourceId: z.string().min(8).max(64),
  credentialKey: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  properties: z.object({
    title: z.string().min(1),
    status: z.string().min(1),
    statusType: z.enum(["status", "select"]).default("status"),
    assignees: z.string().min(1).nullable().default(null),
    due: z.string().min(1).nullable().default(null),
  }).strict(),
}).strict();

const ProjectSchema = z.object({
  code,
  name: z.string().min(1).max(120).optional(),
  /** カリオペの素材 (spec/ux) と Anatomia の照合に使う本体 checkout。 */
  repoPath: z.string().min(1).optional(),
  /** Breviarium のプロジェクトコード (省略時は code)。 */
  breviariumProject: code.optional(),
  /** Actio (CONCORDIA_ACTIO_TASK_BINDINGS) の project (省略時は code)。 */
  actioProject: code.optional(),
  praeformaProjectId: z.string().min(1).max(64).optional(),
}).strict();

export const GlabUnityHubFileSchema = z.object({
  guildId: snowflake.optional(),
  port: z.number().int().min(1).max(65535).optional(),
  /** Cloudflare Tunnel の公開ホスト名 (手順書・表示用。 待受は常に loopback)。 */
  publicHostname: z.string().min(1).max(253).optional(),
  allowedCountries: z.array(z.string().regex(/^[A-Za-z]{2}$/)).optional(),
  geoPolicy: z.enum(["monitor", "block"]).optional(),
  /** 海外接続を知らせる相手 (neco) の Discord ユーザー id。 */
  notifyUserId: snowflake.optional(),
  /** Melpomene のログを添付で上げるバグ報告用チャンネル。 */
  bugReportChannelId: snowflake.optional(),
  notionBoards: z.array(BoardSchema).max(20).default([]),
  melpomeneRepos: z.array(repo).max(50).default([]),
  specRepos: z.array(z.object({ repo, project: code, praeformaProjectId: z.string().min(1).max(64) }).strict()).max(50).default([]),
  projects: z.array(ProjectSchema).max(50).default([]),
  /** Discord ユーザー id → Actio ユーザー id (sprint.tasks.update の担当者判定)。 */
  actioUsers: z.record(snowflake, z.string().min(1).max(128)).default({}),
  /** Actio の Web 画面のタスク URL の土台 (任意)。 */
  actioWebUrl: z.string().url().optional(),
  /** Praeforma の Web 画面の土台 (PR コメントのリンク、 任意)。 */
  praeformaWebUrl: z.string().url().optional(),
}).strict();

export interface HubProject {
  readonly code: string;
  readonly name: string;
  readonly repoPath: string | null;
  readonly breviariumProject: string;
  readonly actioProject: string;
  readonly praeformaProjectId: string | null;
}

export interface GlabUnityHubConfig {
  readonly guildId: string | null;
  readonly host: "127.0.0.1";
  readonly port: number | null;
  readonly publicHostname: string | null;
  readonly allowedCountries: readonly string[];
  readonly geoPolicy: GeoPolicy;
  readonly notifyUserId: string | null;
  readonly bugReportChannelId: string | null;
  readonly notionBoards: readonly NotionBoardConfig[];
  readonly melpomeneRepos: readonly string[];
  readonly specRepos: readonly SpecRepoBinding[];
  readonly projects: readonly HubProject[];
  readonly actioUsers: Readonly<Record<string, string>>;
  readonly actioWebUrl: string | null;
  readonly praeformaWebUrl: string | null;
  readonly dbPath: string;
}

/** 設定ファイルの注釈 (`$comment` など `$` 始まりのキー) は読まない。 */
function withoutComments(section: unknown): unknown {
  if (typeof section !== "object" || section === null || Array.isArray(section)) return section ?? {};
  return Object.fromEntries(Object.entries(section).filter(([key]) => !key.startsWith("$")));
}

/** ファイルの節と env から設定を作る (純関数)。 壊れた節は握りつぶさず throw する。 */
export function resolveGlabUnityHubConfig(fileSection: unknown, env: NodeJS.ProcessEnv, cwd: string): GlabUnityHubConfig {
  const file = GlabUnityHubFileSchema.parse(withoutComments(fileSection));
  const guildEnv = (env.GLAB_UNITY_HUB_GUILD_ID ?? "").trim();
  const portEnv = Number((env.GLAB_UNITY_HUB_PORT ?? "").trim());
  const countriesEnv = env.GLAB_UNITY_HUB_ALLOWED_COUNTRIES;
  const policyEnv = env.GLAB_UNITY_HUB_GEO_POLICY;
  const dbEnv = (env.GLAB_UNITY_HUB_DB_PATH ?? "").trim();
  const concordiaDb = (env.CONCORDIA_DB_PATH ?? "").trim() || join(cwd, "concordia.db");
  return {
    guildId: /^\d{5,25}$/.test(guildEnv) ? guildEnv : file.guildId ?? null,
    host: "127.0.0.1",
    port: Number.isInteger(portEnv) && portEnv > 0 && portEnv <= 65535 ? portEnv : file.port ?? null,
    publicHostname: file.publicHostname ?? null,
    allowedCountries: parseAllowedCountries(countriesEnv?.trim() ? countriesEnv : (file.allowedCountries ?? []).join(",")),
    geoPolicy: parseGeoPolicy(policyEnv?.trim() ? policyEnv : file.geoPolicy),
    notifyUserId: file.notifyUserId ?? null,
    bugReportChannelId: file.bugReportChannelId ?? null,
    notionBoards: file.notionBoards,
    melpomeneRepos: file.melpomeneRepos,
    specRepos: file.specRepos,
    projects: file.projects.map((project) => ({
      code: project.code,
      name: project.name ?? project.code,
      repoPath: project.repoPath ?? null,
      breviariumProject: project.breviariumProject ?? project.code,
      actioProject: project.actioProject ?? project.code,
      praeformaProjectId: project.praeformaProjectId ?? null,
    })),
    actioUsers: file.actioUsers,
    actioWebUrl: file.actioWebUrl ?? null,
    praeformaWebUrl: file.praeformaWebUrl ?? null,
    dbPath: dbEnv || join(dirname(concordiaDb), "glab-unity-hub.sqlite"),
  };
}

/** concordia.config.json の `glabUnityHub` 節を読む。 ファイルが無ければ空の節。 */
export function readGlabUnityHubFileSection(cwd: string = process.cwd()): unknown {
  const path = join(cwd, "concordia.config.json");
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, "utf8")) as { glabUnityHub?: unknown };
  return raw?.glabUnityHub ?? {};
}

export function loadGlabUnityHubConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): GlabUnityHubConfig {
  return resolveGlabUnityHubConfig(readGlabUnityHubFileSection(cwd), env, cwd);
}
