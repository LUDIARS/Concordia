import { describe, expect, it } from "vitest";
import { actioBindingResolver, missingStartupSettings } from "./glab-unity-hub-worker.js";
import { resolveGlabUnityHubConfig } from "./glab-unity-hub/adapters/hub-config.js";

describe("GLab-UnityHub worker の起動条件", () => {
  it("guild id と待受ポートが無ければ起動しない", () => {
    expect(missingStartupSettings(resolveGlabUnityHubConfig({}, {}, "/x"))).toEqual([
      "GLAB_UNITY_HUB_GUILD_ID (or glabUnityHub.guildId)",
      "GLAB_UNITY_HUB_PORT (catalog env)",
    ]);
    expect(missingStartupSettings(resolveGlabUnityHubConfig({}, { GLAB_UNITY_HUB_GUILD_ID: "222222222222222222", GLAB_UNITY_HUB_PORT: "11115" }, "/x"))).toEqual([]);
  });

  it("プロジェクトコードから Actio binding を引く (actioProject で読み替え)", () => {
    const binding = { repoPath: "E:/a", project: "CookieClickerActio", projectId: "pid", ownerId: "actio-local", authMode: "loopback" as const, subsidiaryId: null, teamId: null };
    const config = resolveGlabUnityHubConfig({ projects: [{ code: "CC", actioProject: "CookieClickerActio" }] }, {}, "/x");
    const resolve = actioBindingResolver([binding], config);
    expect(resolve("CC")).toBe(binding);
    expect(resolve("Unknown")).toBeNull();
  });
});
