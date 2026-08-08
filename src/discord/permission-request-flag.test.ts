import { describe, expect, it } from "vitest";
import {
  shouldPostPermissionRequestToDiscord,
  toPermissionRequestsResolver,
} from "./permission-request-flag.js";

describe("toPermissionRequestsResolver (W6)", () => {
  it("固定値を渡してもその値を返す resolver になる", () => {
    expect(toPermissionRequestsResolver({ permissionRequestsEnabled: true })()).toBe(true);
    expect(toPermissionRequestsResolver({ permissionRequestsEnabled: false })()).toBe(false);
  });

  it("関数を渡すと呼び出しのたびに解決する (再起動なしで設定変更が効く)", () => {
    let permissionRequestsEnabled = false;
    const resolve = toPermissionRequestsResolver(() => ({ permissionRequestsEnabled }));

    expect(resolve()).toBe(false);
    permissionRequestsEnabled = true;
    expect(resolve()).toBe(true);
    permissionRequestsEnabled = false;
    expect(resolve()).toBe(false);
  });

  it("判定本体は純関数のまま", () => {
    expect(shouldPostPermissionRequestToDiscord({ permissionRequestsEnabled: true })).toBe(true);
    expect(shouldPostPermissionRequestToDiscord({ permissionRequestsEnabled: false })).toBe(false);
  });
});
