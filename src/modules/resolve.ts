import { MODULE_MANIFEST, type ModuleManifestEntry, type ModuleMode } from "./manifest.js";

/**
 * 台帳のモジュールについて、 実際に解決されたモードを引く。
 *
 * モードの読み取り規則は各モジュールの既存関数 (`readChatMode` など) が正本で、
 * ここはそれを写さない。 **同じ規則を 2 箇所に書くと、 片方だけ変わったときに
 * 台帳が嘘をつく**ため、 呼び出し側から解決関数を受け取る。
 *
 * @implements spec/feature/module-manifest.md §2
 */

export interface ResolvedModule extends ModuleManifestEntry {
  /** 解決されたモード。 modeEnv が null のモジュールは modes の先頭。 */
  readonly mode: ModuleMode;
  /** 台帳と実配線の不一致。 空なら一致。 */
  readonly mismatches: readonly string[];
}

/** モジュール名 → 解決されたモード。 呼び出し側が既存の読み取り関数から作る。 */
export type ModeResolver = (entry: ModuleManifestEntry) => ModuleMode;

/**
 * 実配線の観測値。 起動時に bootstrap が「実際に何を起動したか」を渡す。
 * 台帳が embedded と言っているのに起動していない、 のような食い違いを見つける。
 */
export interface WiringObservation {
  /** 実際に backend 内で起動したモジュール名。 */
  readonly startedEmbedded: readonly string[];
  /** mount された route group 名 (あれば)。 */
  readonly mountedRouteGroups?: readonly string[];
}

/**
 * 台帳と実配線を突き合わせる。
 *
 * **無言の縮退をしない**のが目的。 「off にしたつもりが動いていた」も
 * 「embedded のつもりが起動していなかった」も、 どちらも気づけないまま運用が続く。
 *
 * @implements spec/feature/module-manifest.md §2
 */
export function resolveModules(
  resolveMode: ModeResolver,
  wiring: WiringObservation,
): ResolvedModule[] {
  const started = new Set(wiring.startedEmbedded);
  const modules: ResolvedModule[] = [];
  for (const entry of MODULE_MANIFEST) {
    const mode = entry.modeEnv ? resolveMode(entry) : entry.modes[0];
    const mismatches: string[] = [];

    if (!entry.modes.includes(mode)) {
      mismatches[mismatches.length] =
        `解決されたモード ${mode} は台帳の modes (${entry.modes.join("/")}) に無い`;
    }
    if (mode === "embedded" && !started.has(entry.name)) {
      mismatches[mismatches.length] = "embedded と解決されたが backend 内で起動していない";
    }
    if (mode !== "embedded" && started.has(entry.name)) {
      mismatches[mismatches.length] = `${mode} と解決されたのに backend 内で起動している`;
    }
    if (mode === "worker" && !entry.excubitorCode) {
      mismatches[mismatches.length] = "worker と解決されたが台帳に Excubitor code が無い";
    }

    modules.push({ ...entry, mode, mismatches });
  }
  return modules;
}

/**
 * 不一致を 1 行ずつの警告文へ落とす。
 *
 * 起動を止めない — モードの食い違いは設定の不備だが、 **止めると直す手段まで失う**
 * (backend が上がらないと設定 UI も API も使えない)。 error ログで fail-visible にする。
 *
 * @implements spec/feature/module-manifest.md §2
 */
export function describeMismatches(modules: readonly ResolvedModule[]): string[] {
  const lines: string[] = [];
  for (const module of modules) {
    for (const mismatch of module.mismatches) {
      lines[lines.length] = `[module] ${module.name}: ${mismatch}`;
    }
  }
  return lines;
}
