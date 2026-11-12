/**
 * ゴールを止める質問の前段の絞り込み (純関数、spec/feature/goal-stop-question-guard.md)。
 *
 * LLM に渡す前に、明らかに対象外の質問を落とす:
 * - 破壊的操作・取り返しのつかない操作の語がある質問は、判定しない (質問を続けさせる)。
 * - 「やる / やらない」「許可 / 見送り」を選ばせる形でない質問は、判定しない。
 *
 * @implements SPEC-GOAL-STOP-Q-01
 */

export interface AskedQuestion {
  question: string;
  options: string[];
}

export interface PrefilterVerdict {
  candidate: boolean;
  reason: "destructive" | "not-a-go-question" | "go-question";
}

/** 質問を続けるべき (人間が決める) 操作の語。ここに当たれば判定しない。 */
const DESTRUCTIVE = [
  /削除|消去|消す|破棄|捨てる|初期化|リセット|ロールバック|巻き戻|上書き/,
  /force[- ]?push|--force|rm\s+-rf|drop\s+(table|database)|truncate|reset\s+--hard/i,
  /本番|production|課金|請求|支払|送金|公開する|リリースする|外部へ送/i,
  /鍵|パスワード|資格情報|credential|secret|token/i,
];

/** 「進めるか止めるか」を選ばせる形の語 (質問または選択肢)。 */
const GO_OR_STOP = [
  /見送|止めて待|止める|やめ|後日|保留|今回は|待機|中止|スキップ/,
  /許可|実行して(よい|いい)|進めて(よい|いい)|進めますか|しますか|足しますか|やりますか|よろしいですか/,
];

export function prefilterGoalStopQuestion(asked: AskedQuestion): PrefilterVerdict {
  const text = [asked.question, ...asked.options].join("\n");
  if (DESTRUCTIVE.some((pattern) => pattern.test(text))) return { candidate: false, reason: "destructive" };
  if (!GO_OR_STOP.some((pattern) => pattern.test(text))) return { candidate: false, reason: "not-a-go-question" };
  return { candidate: true, reason: "go-question" };
}
