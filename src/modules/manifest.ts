/**
 * サービスモジュールの宣言的台帳。
 *
 * Concordia は chat / cost / workflow などを embedded (backend 内) と worker (別プロセス) で
 * 切り替えられるが、**どのモジュールがどのモードで動いているかを 1 箇所から見る手段が無かった**。
 * 環境変数と bootstrap の分岐に散っていて、「いま何が止まっているのか」を知るには
 * コードを読むしかない。
 *
 * off にしたときに何が止まり何が生きるか (`degradedNote`) も、宣言として持たないと
 * 運用側が判断できない。
 *
 * @implements spec/feature/module-manifest.md §1
 */

/** モジュールの動かし方。 embedded = backend 内、 worker = 別プロセス、 off = 動かさない。 */
export type ModuleMode = "embedded" | "worker" | "off";

export interface ModuleManifestEntry {
  /** 台帳上の名前。 `GET /v1/modules` のキーになる。 */
  readonly name: string;
  /** 担当するドメイン (spec/domains の名前に対応)。 */
  readonly domain: string;
  /**
   * モードを決める環境変数。 常時動くモジュール (core など) は null。
   * 読み取りは各モジュールの既存関数が持つので、 ここでは名前だけを宣言する。
   */
  readonly modeEnv: string | null;
  /** 取りうるモード。 常時動くものは `["embedded"]` だけ。 */
  readonly modes: readonly ModuleMode[];
  /** worker で動かすときの Excubitor サービスコード。 embedded 専用なら null。 */
  readonly excubitorCode: string | null;
  /** health を見る経路。 backend に同居するものは backend の /health を指す。 */
  readonly healthPath: string;
  /** **off にすると何が止まり、何が生き残るか。** 運用が判断するための説明。 */
  readonly degradedNote: string;
}

/**
 * 初期台帳。
 *
 * 「現状こう動いている」を写したものであって、 これから分離するモジュール
 * (pr / director / messages) は含めない。 台帳が実配線より先に進むと、
 * 起動時検査が常に不一致を報告することになる。
 */
export const MODULE_MANIFEST: readonly ModuleManifestEntry[] = [
  {
    name: "core",
    domain: "runtime-orchestration",
    modeEnv: null,
    modes: ["embedded"],
    excubitorCode: "concordia",
    healthPath: "/health",
    degradedNote: "止められない。 sessions / control API と sweeper を持つ本体。",
  },
  {
    name: "control-jobs",
    domain: "runtime-orchestration",
    modeEnv: null,
    modes: ["worker"],
    excubitorCode: "concordia-control",
    healthPath: "/health",
    degradedNote:
      "止まると taskkill / reaper が動かず、 終了しないセッションが残り続ける。"
      + " backend 側の API は生きるので受付は続く。",
  },
  {
    name: "chat",
    domain: "session-message-layer",
    modeEnv: "CONCORDIA_CHAT_MODE",
    modes: ["embedded", "worker", "off"],
    excubitorCode: null,
    healthPath: "/health",
    degradedNote:
      "off にすると Discord / Slack の投稿と受信が止まる。"
      + " セッション自体は動き、 transcript も溜まるが、 人からは見えなくなる。",
  },
  {
    name: "cost",
    domain: "observability",
    modeEnv: "CONCORDIA_COST_MODE",
    modes: ["embedded", "worker", "off"],
    excubitorCode: "concordia-cost",
    healthPath: "/health",
    degradedNote:
      "off にするとトークン消費のサンプリングが止まり、 日次コストと予算ブロックが効かなくなる。"
      + " セッションの実行そのものは止まらない。",
  },
  {
    name: "workflow",
    domain: "delegation-queue",
    modeEnv: "CONCORDIA_WORKFLOW_MODE",
    modes: ["embedded", "worker", "off"],
    excubitorCode: null,
    healthPath: "/health",
    degradedNote:
      "off にすると delegation の queue が進まない。 委託の登録は受け付けるが起動されない。",
  },
];

/** 台帳から 1 件引く。 未知の名前は null (throw しない — 表示のための読み取り面なので)。 */
export function findModule(name: string): ModuleManifestEntry | null {
  return MODULE_MANIFEST.find((entry) => entry.name === name) ?? null;
}
