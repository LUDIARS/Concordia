import { api } from "../../api.js";

const CLIENT_ID_KEY = "concordia-client-id";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let volatileClientId: string | null = null;

/** @implements spec/feature/session-message-webui-chat.md — D4 browser identity and Web Push */
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

/** @implements spec/feature/session-message-webui-chat.md §1.4 */
export async function subscribePush(): Promise<void> {
  if (!("serviceWorker" in navigator) || !("Notification" in window) || !("PushManager" in window)) {
    throw new Error("このブラウザは Web Push に対応していません");
  }
  await navigator.serviceWorker.register("/sw.js");
  const registration = await navigator.serviceWorker.ready;
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("通知が許可されていません");
  const { public_key } = await api.pushPublicKey();
  const subscription = await registration.pushManager.getSubscription()
    ?? await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeVapidKey(public_key),
    });
  await api.pushSubscribe(clientId(), subscription.toJSON());
}

function decodeVapidKey(value: string): Uint8Array<ArrayBuffer> {
  const padded = value + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
