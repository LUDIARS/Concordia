import { describe, expect, it } from "vitest";
import { readWebSsoConfig, WebSsoConfigError } from "./config.js";

const full = {
  CONCORDIA_WEB_PUBLIC_HOST: "CC.Example.com",
  CERNERE_URL: "https://cernere.example.com/",
  CONCORDIA_CERNERE_PROJECT_KEY: "concordia",
  CONCORDIA_CERNERE_CLIENT_ID: "client",
  CONCORDIA_CERNERE_CLIENT_SECRET: "secret",
};

describe("readWebSsoConfig", () => {
  it("公開ホストが無ければ無効 (今までの動作)", () => {
    expect(readWebSsoConfig({})).toBeNull();
    expect(readWebSsoConfig({ CERNERE_URL: "https://cernere.example.com" })).toBeNull();
  });

  it("揃っていればホストを小文字に、URL の末尾 / を落とす", () => {
    expect(readWebSsoConfig(full)).toEqual({
      publicHost: "cc.example.com",
      cernereUrl: "https://cernere.example.com",
      projectKey: "concordia",
      clientId: "client",
      clientSecret: "secret",
    });
  });

  it("公開ホストを有効にして Cernere の情報が欠けていれば起動を止める", () => {
    const { CONCORDIA_CERNERE_CLIENT_SECRET: _drop, ...missing } = full;
    expect(() => readWebSsoConfig(missing)).toThrow(WebSsoConfigError);
    expect(() => readWebSsoConfig(missing)).toThrow(/CONCORDIA_CERNERE_CLIENT_SECRET/);
  });

  it("公開ホストにスキームやポートを書いたら止める", () => {
    expect(() => readWebSsoConfig({ ...full, CONCORDIA_WEB_PUBLIC_HOST: "https://cc.example.com" })).toThrow(WebSsoConfigError);
    expect(() => readWebSsoConfig({ ...full, CONCORDIA_WEB_PUBLIC_HOST: "cc.example.com:443" })).toThrow(WebSsoConfigError);
  });

  it("CERNERE_URL が http(s) でなければ止める", () => {
    expect(() => readWebSsoConfig({ ...full, CERNERE_URL: "not a url" })).toThrow(WebSsoConfigError);
    expect(() => readWebSsoConfig({ ...full, CERNERE_URL: "ftp://cernere.example.com" })).toThrow(WebSsoConfigError);
  });
});
