import { describe, expect, it } from "vitest";
import { isAttachmentEnforced, configuredAttachmentRoots } from "./attachment-policy.js";
import { isClaudeDisabled } from "./claude-availability.js";

function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

const EMPTY = {} as NodeJS.ProcessEnv;

describe("isClaudeDisabled", () => {
  it("既定は有効 (無効化しない)", () => {
    expect(isClaudeDisabled(EMPTY)).toBe(false);
    expect(isClaudeDisabled(env({ CONCORDIA_DISABLE_CLAUDE: "0" }))).toBe(false);
  });

  it('"1" のときだけ無効', () => {
    expect(isClaudeDisabled(env({ CONCORDIA_DISABLE_CLAUDE: "1" }))).toBe(true);
  });
});

describe("isAttachmentEnforced", () => {
  it("既定は enforce ON", () => {
    expect(isAttachmentEnforced(EMPTY)).toBe(true);
  });

  it('"0" のときだけ audit のみ', () => {
    expect(isAttachmentEnforced(env({ CONCORDIA_ATTACHMENT_ENFORCE: "0" }))).toBe(false);
    expect(isAttachmentEnforced(env({ CONCORDIA_ATTACHMENT_ENFORCE: "1" }))).toBe(true);
  });
});

describe("configuredAttachmentRoots", () => {
  it("生の env 値をそのまま返す (分解は attachment-paths の責務)", () => {
    expect(configuredAttachmentRoots(env({ CONCORDIA_ATTACHMENT_ROOTS: "C:\\a;C:\\b" }))).toBe(
      "C:\\a;C:\\b",
    );
    expect(configuredAttachmentRoots(EMPTY)).toBeUndefined();
  });
});
