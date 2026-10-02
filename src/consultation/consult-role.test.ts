import { describe, expect, it } from "vitest";
import { consultRoleFolder } from "./consult-role.js";

describe("consultRoleFolder", () => {
  it("役職を役職フォルダに読む", () => {
    expect(consultRoleFolder("エンジニア")).toBe("engineer");
    expect(consultRoleFolder("プログラマー")).toBe("engineer");
    expect(consultRoleFolder("企画")).toBe("planner");
    expect(consultRoleFolder("プランナー")).toBe("planner");
    expect(consultRoleFolder("UI デザイナー")).toBe("designer");
    expect(consultRoleFolder("サウンドクリエイター")).toBe("sound");
    expect(consultRoleFolder("コンポーザー")).toBe("sound");
  });

  it("重なる役職は上から順に当てる (サウンド → デザイナー → 企画 → エンジニア)", () => {
    expect(consultRoleFolder("Sound designer")).toBe("sound");
    expect(consultRoleFolder("アートディレクター")).toBe("designer");
  });

  it("読めない役職・未記入は general", () => {
    expect(consultRoleFolder("学生")).toBe("general");
    expect(consultRoleFolder("")).toBe("general");
    expect(consultRoleFolder(null)).toBe("general");
  });
});
