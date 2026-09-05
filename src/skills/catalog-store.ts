/**
 * スキルカタログのプロセス内キャッシュ (設計 §10.2 C-8)。
 *
 * 走査はディスク I/O なので、 起動時に 1 度だけ走らせて結果を保持し、
 * `POST /v1/skills/refresh` で明示的に再走査する。 リアクション 1 回ごとに
 * `.claude/` を舐め直さないための層。
 *
 * SRP: キャッシュのライフサイクルのみ。 走査は catalog.ts。
 */

import { scanSkillCatalog, type SkillCatalog, type SkillCatalogEntry } from "./catalog.js";

/** 空カタログ (起動直後・走査失敗時の既定)。 */
const EMPTY: SkillCatalog = { entries: [], notes: [], scannedAt: 0 };

export class SkillCatalogStore {
  private cache: SkillCatalog = EMPTY;
  private inflight: Promise<SkillCatalog> | null = null;

  /** @param resolveWorkspaceRoot Castra ルートを都度解決する (設定変更に追従する)。 */
  constructor(private readonly resolveWorkspaceRoot: () => string) {}

  /** 直近の走査結果 (未走査なら空)。 同期で読めることが呼び出し側の前提。 */
  current(): SkillCatalog {
    return this.cache;
  }

  /** 名前でスキルを引く。 skills > commands > user の登録順で先勝ち。 */
  find(name: string): SkillCatalogEntry | null {
    const target = name.trim();
    if (!target) return null;
    return this.cache.entries.find((entry) => entry.name === target) ?? null;
  }

  /**
   * 再走査する。 同時呼び出しは 1 本にまとめる (起動時と refresh が重なっても
   * `.claude/` を二重に舐めない)。
   */
  async refresh(): Promise<SkillCatalog> {
    if (this.inflight) return this.inflight;
    const run = scanSkillCatalog(this.resolveWorkspaceRoot())
      .then((catalog) => {
        this.cache = catalog;
        return catalog;
      })
      .catch(() => this.cache)
      .finally(() => {
        this.inflight = null;
      });
    this.inflight = run;
    return run;
  }

  /** 未走査なら 1 度だけ走査する (起動時の遅延初期化)。 */
  async ensure(): Promise<SkillCatalog> {
    if (this.cache.scannedAt > 0) return this.cache;
    return this.refresh();
  }
}
