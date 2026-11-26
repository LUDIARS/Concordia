/**
 * 委託の子が Actio の本文を取得するときの決まり文句。
 *
 * 一時的な 503 (taskflow_actio_unavailable_or_invalid_scope) を 1 回受けただけで子が着手前に
 * 止まり、親が手で出し直す事故が続いた (2026-11-26、run 3e98b3a0・be865004・f948d672・381e2464)。
 * 短い間隔で数回やり直してから止める。
 */
export const ACTIO_CONTENT_FETCH_RETRY_SECONDS = 30;
export const ACTIO_CONTENT_FETCH_ATTEMPTS = 3;

export const ACTIO_CONTENT_FETCH_RULE =
  `取得が HTTP 503 などの一時的な失敗なら ${ACTIO_CONTENT_FETCH_RETRY_SECONDS} 秒あけて合計 ${ACTIO_CONTENT_FETCH_ATTEMPTS} 回まで試し、` +
  "それでも取得できなければ停止して報告してください。";
