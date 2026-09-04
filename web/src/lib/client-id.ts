/**
 * ブラウザ 1 台ぶんの識別子。 既読・スヌーズ・Web Push の宛先がこれで分かれる。
 *
 * サーバ側の身元ではない — 「自分は見た / 相方はまだ」を分けるためだけのもの。
 * localStorage が使えない環境 (プライベートウィンドウ等) ではタブ限りの値になる。
 *
 * @implements spec/feature/session-message-webui-chat.md — D4 browser identity and Web Push
 */

const CLIENT_ID_KEY = "concordia-client-id";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let volatileClientId: string | null = null;

export function clientId(): string {
  try {
    const stored = localStorage.getItem(CLIENT_ID_KEY);
    if (stored && UUID_PATTERN.test(stored)) return stored;
    const generated = crypto.randomUUID();
    localStorage.setItem(CLIENT_ID_KEY, generated);
    return generated;
  } catch {
    // Storage can be unavailable in hardened/private contexts; keep a tab-local identity.
    volatileClientId ??= crypto.randomUUID();
    return volatileClientId;
  }
}
