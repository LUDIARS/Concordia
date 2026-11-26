/**
 * メソッド処理に渡す文脈と、 メソッド表の型。
 *
 * @implements spec/feature/glab-unity-hub.md §3 (GUH-METHODS)
 */

import type { HubMethod, HubPayload } from "../domain/methods.js";
import type { HubIdentity } from "./authenticate.js";

/** その接続の購読を操作する口 (discord.subscribe / unsubscribe)。 */
export interface SubscriptionControl {
  subscribe(channelId: string): void;
  unsubscribe(channelId: string): void;
}

export interface MethodContext {
  readonly identity: HubIdentity;
  readonly subscriptions: SubscriptionControl;
}

export type MethodHandler<M extends HubMethod> = (context: MethodContext, payload: HubPayload<M>) => Promise<unknown>;

export type MethodHandlers = { readonly [M in HubMethod]: MethodHandler<M> };
