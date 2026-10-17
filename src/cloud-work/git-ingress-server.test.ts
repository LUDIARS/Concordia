import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { cloudGitIngressSettings } from "./git-ingress-server.js";

const env = { CONCORDIA_CLOUD_GIT_ROOT: resolve("private-return-data"), CONCORDIA_CLOUD_GIT_PUBLIC_HOST: "git.example.com",
  CONCORDIA_CLOUD_GIT_PORT: "11114", CONCORDIA_CLOUD_GIT_ACCESS_TEAM: "https://team.cloudflareaccess.com", CONCORDIA_CLOUD_GIT_ACCESS_AUD: "a".repeat(64) };
describe("Git ingress deployment settings", () => {
  it("requires explicit private storage and Access binding", () => {
    expect(cloudGitIngressSettings(env)).toMatchObject({ host: "git.example.com", port: 11114 });
    expect(() => cloudGitIngressSettings({})).toThrow();
  });
  it.each(Object.keys(env))("does not fall back if %s is absent", key => {
    expect(() => cloudGitIngressSettings({ ...env, [key]: undefined })).toThrow();
  });
  it.each(["80", "65536", "0", "1234junk"])("rejects invalid port %s", port => {
    expect(() => cloudGitIngressSettings({ ...env, CONCORDIA_CLOUD_GIT_PORT: port })).toThrow();
  });
});
