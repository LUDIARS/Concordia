/**
 * Actio への書き込みに「だれの指示か」を付ける (Actio spec/feature/cc-acting-for.md, AT-CC-ACTING-FOR)。
 *
 * Concordia は Actio にローカル持ち主として書き込むため、Actio 側では指示した人が分からない。
 * セッション起点の処理を `withActingFor` で囲むと、その中の Actio 書き込みに
 * `x-actio-acting-for: <platform>:<userId>` が付き、Actio の操作ログに残る (DB には残らない)。
 *
 * SRP: 指示者の受け渡しとヘッダ値の組み立てだけ。指示者の特定は control/requester.ts。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Requester } from "../control/requester.js";

export const ACTING_FOR_HEADER = "x-actio-acting-for";

const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const current = new AsyncLocalStorage<Requester | null>();

export function withActingFor<T>(requester: Requester | null, run: () => Promise<T>): Promise<T> {
  return current.run(requester, run);
}

/** 現在の指示者のヘッダ。指示者が無い・形式が合わない場合は付けない。 */
export function actingForHeaders(): Record<string, string> {
  const requester = current.getStore();
  if (!requester || !USER_ID.test(requester.userId)) return {};
  return { [ACTING_FOR_HEADER]: `${requester.platform}:${requester.userId}` };
}
