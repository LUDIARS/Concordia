import { describe, expect, it, vi } from "vitest";
import { CernereRejectedError } from "./cernere-project-channel.js";
import { EnterpriseSessionClient } from "./enterprise-session-client.js";

const info = { userId: "u1", projectKey: "concordia", organizationId: "org", organizationRole: "admin", expiresAt: 100, amr: ["webauthn"] };

describe("EnterpriseSessionClient", () => {
  it("login は Access JWT をそのまま Cernere の enterprise.login に渡す", async () => {
    const request = vi.fn(async () => ({ enterpriseToken: "tok", session: info }));
    const result = await new EnterpriseSessionClient({ request }).login("jwt");
    expect(request).toHaveBeenCalledWith("enterprise", "login", { assertion: "jwt" });
    expect(result).toEqual({
      enterpriseToken: "tok",
      session: { userId: "u1", projectKey: "concordia", organizationId: "org", organizationRole: "admin", expiresAt: 100 },
    });
  });

  it("verify / logout は enterpriseToken を渡す", async () => {
    const request = vi.fn(async () => info);
    const client = new EnterpriseSessionClient({ request });
    await expect(client.verify("tok")).resolves.toMatchObject({ userId: "u1" });
    await client.logout("tok");
    expect(request).toHaveBeenNthCalledWith(1, "enterprise", "verify", { enterpriseToken: "tok" });
    expect(request).toHaveBeenNthCalledWith(2, "enterprise", "logout", { enterpriseToken: "tok" });
  });

  it("欠けた応答は拒否として扱う", async () => {
    await expect(new EnterpriseSessionClient({ request: async () => ({ session: info }) }).login("jwt"))
      .rejects.toBeInstanceOf(CernereRejectedError);
    await expect(new EnterpriseSessionClient({ request: async () => ({ userId: "u1" }) }).verify("tok"))
      .rejects.toBeInstanceOf(CernereRejectedError);
  });
});
