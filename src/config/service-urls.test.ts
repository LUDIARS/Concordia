import { describe, expect, it } from "vitest";
import {
  anatomiaBaseUrl,
  concordiaBaseUrl,
  excubitorBaseUrl,
  memoriaBaseUrl,
  thaleiaBaseUrl,
  villaBaseUrl,
} from "./service-urls.js";

const EMPTY = {} as NodeJS.ProcessEnv;

function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

describe("service base URL resolution", () => {
  it("env 未設定なら既定へ落ちる", () => {
    expect(concordiaBaseUrl(EMPTY)).toBe("http://127.0.0.1:11111");
    expect(excubitorBaseUrl(EMPTY)).toBe("http://127.0.0.1:17332");
    expect(memoriaBaseUrl(EMPTY)).toBe("http://127.0.0.1:5180");
    expect(anatomiaBaseUrl(EMPTY)).toBe("http://127.0.0.1:4200");
    expect(thaleiaBaseUrl(EMPTY)).toBe("http://127.0.0.1:8890");
    expect(villaBaseUrl(EMPTY)).toBe("http://127.0.0.1:17610");
  });

  it("env 指定を採用し末尾スラッシュを落とす", () => {
    expect(memoriaBaseUrl(env({ CONCORDIA_MEMORIA_URL: "http://mem:9000//" }))).toBe(
      "http://mem:9000",
    );
  });

  it("空文字 env は未設定として既定へ落とす", () => {
    expect(villaBaseUrl(env({ CONCORDIA_VILLA_URL: "   " }))).toBe("http://127.0.0.1:17610");
  });
});

describe("excubitorBaseUrl", () => {
  it("CONCORDIA_EXCUBITOR_URL を EXCUBITOR_URL より優先する", () => {
    expect(
      excubitorBaseUrl(
        env({ CONCORDIA_EXCUBITOR_URL: "http://a:1", EXCUBITOR_URL: "http://b:2" }),
      ),
    ).toBe("http://a:1");
  });

  it("Excubitor 慣用キー EXCUBITOR_URL も受ける", () => {
    expect(excubitorBaseUrl(env({ EXCUBITOR_URL: "http://b:2" }))).toBe("http://b:2");
  });
});
