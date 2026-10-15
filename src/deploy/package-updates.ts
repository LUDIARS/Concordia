import { contract } from './ontime-runtime.js'; /* augur-inject:import:dd8b97a3 */
import augurContract_09ffeffd from './package-updates.contract.js'; /* augur-inject:contract-predicate:ac4a18b4 */
import augurContract_fe13520f from './package-updates.contract.js'; /* augur-inject:contract-predicate:f61b52e5 */
/**
 * Ergo パッケージ更新のお知らせを本社のデプロイ通知チャンネルへ流す (spec/feature/package-update-events.md)。
 *
 * Excubitor (ergo-watch) が 1 回の実行で組み立てた文面を、 Concordia が Bot で順に投稿する。
 * 文面の中身は送り手の責務。 Concordia は mention を無害化し、 (runId, 添字) で二重投稿を止めるだけ。
 */

export interface PackageUpdateMessage { text: string; private: boolean; }
export interface PackageUpdateEvent { source: "ergo-watch"; runId: string; messages: PackageUpdateMessage[]; }

/** (runId, 添字) ごとの at-most-once 台帳。 配送に失敗した添字は release して再送を許す。 */
export interface PackageUpdateLedger {
  claim(runId: string, index: number): boolean;
  release(runId: string, index: number): void;
}

export interface PackageUpdateFailure { index: number; error: string; }
export interface PackageUpdateOutcome { delivered: number; failed: PackageUpdateFailure[]; duplicate: boolean; }

const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/**
 * Discord で mention として解釈されうる並びを崩す。 allowed_mentions を空にした上での二重化
 * (通知が鳴らないだけでなく、 表示上も `@everyone` や `<@id>` にならない)。
 */
export function neutralizePackageUpdateText(text: string): string {
  return text
    .replace(/@(?=(everyone|here)\b)/gi, `@${ZERO_WIDTH_SPACE}`)
    .replace(/<(?=[@#&!]|:[a-z]+:)/gi, `<${ZERO_WIDTH_SPACE}`);
}
// @ts-expect-error augur-inject
neutralizePackageUpdateText = contract(neutralizePackageUpdateText, { ...augurContract_fe13520f, contractId: 'pkg-upd-C-2', mode: 'observe', sample: 1, where: 'src/deploy/package-updates.ts:26', rule: 'contract-wrap', id: 'fe13520f' }); /* augur-inject:contract-wrap:fe13520f */

/**
 * 1 回の実行分を順に投稿する。 既に投稿済み (claim 済み) の添字は飛ばし、 全添字が投稿済みなら duplicate。
 * 投稿に失敗した添字は台帳から外し、 失敗を配送済みに数えない (CC-INV-06)。
 */
export async function handlePackageUpdates(input: {
  event: PackageUpdateEvent;
  ledger: PackageUpdateLedger;
  post: (content: string) => Promise<void>;
}): Promise<PackageUpdateOutcome> {
  let delivered = 0;
  let claimed = 0;
  const failed: PackageUpdateFailure[] = [];
  for (const [index, message] of input.event.messages.entries()) {
    if (!input.ledger.claim(input.event.runId, index)) continue;
    claimed += 1;
    try {
      await input.post(neutralizePackageUpdateText(message.text));
      delivered += 1;
    } catch (error) {
      input.ledger.release(input.event.runId, index);
      failed.push({ index, error: error instanceof Error ? error.message : "delivery failed" });
    }
  }
  return { delivered, failed, duplicate: claimed === 0 };
}
// @ts-expect-error augur-inject
handlePackageUpdates = contract(handlePackageUpdates, { ...augurContract_09ffeffd, contractId: 'pkg-upd-C-1', mode: 'observe', sample: 1, where: 'src/deploy/package-updates.ts:36', rule: 'contract-wrap', id: '09ffeffd' }); /* augur-inject:contract-wrap:09ffeffd */
