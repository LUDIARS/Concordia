/**
 * AI プレイテスト感想を Tabula にも共有ページとして載せる口 (CC-PLAYTEST-INV-05)。
 * 設定「Tabula にも投稿する」(playtest_notify.tabula_enabled) が有効で、 技術相談と同じ Tabula の接続先と取り込み
 * トークン (services.tabula_url / services.tabula_import_token) が揃っているときだけ投稿する。 送り手は Tabula を知らない。
 * 冪等キーは `playtest:<runId>` なので、 同じ run を送り直しても Tabula のページは 1 つ。
 *
 * @implements spec/feature/playtest-review-notify.md — Tabula への投稿
 */

import type { TabulaConnection, TabulaImportInput, TabulaImportResult } from "../consultation/tabula-client.js";
import type { PlaytestReviewEvent } from "./playtest-review-notice.js";

export interface PlaytestReviewTabula {
  /** 設定で有効か (接続先の有無とは別)。 無効なら投稿しない。 */
  enabled(): boolean;
  post(event: PlaytestReviewEvent, content: string): Promise<TabulaImportResult>;
}

export class TabulaNotConfiguredError extends Error {
  constructor() {
    super("tabula is enabled for playtest reviews but its url or import token is not set");
    this.name = "TabulaNotConfiguredError";
  }
}

export function playtestTabulaPage(event: PlaytestReviewEvent, content: string): TabulaImportInput {
  return {
    key: `playtest:${event.runId}`,
    title: `AI プレイテスト: ${event.gameTitle.trim()} (${event.persona})`,
    text: content,
    tags: ["ai-playtest", `game:${event.gameId}`, `persona:${event.persona}`],
  };
}

export function createPlaytestReviewTabula(input: {
  enabled: () => boolean;
  connection: () => TabulaConnection | null;
  importPage: (connection: TabulaConnection, page: TabulaImportInput) => Promise<TabulaImportResult>;
}): PlaytestReviewTabula {
  return {
    enabled: input.enabled,
    async post(event, content) {
      const connection = input.connection();
      if (!connection) throw new TabulaNotConfiguredError();
      return input.importPage(connection, playtestTabulaPage(event, content));
    },
  };
}
