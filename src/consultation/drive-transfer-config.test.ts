import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseServiceAccountKey, readDriveTransferConfig } from "./drive-transfer-config.js";

// A throwaway key generated per run, so no key material is committed with the fixture.
const PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const KEY = JSON.stringify({
  type: "service_account",
  client_email: "cc-consult@project.iam.gserviceaccount.com",
  private_key: PRIVATE_KEY,
  token_uri: "https://oauth2.googleapis.com/token",
});

describe("readDriveTransferConfig", () => {
  it("returns the config only when both the key and the parent folder are set", () => {
    expect(readDriveTransferConfig({ serviceAccountJson: KEY, parentFolderId: "0AbCdEfGhIjK" })).toEqual({
      parentFolderId: "0AbCdEfGhIjK",
      serviceAccount: {
        clientEmail: "cc-consult@project.iam.gserviceaccount.com",
        privateKey: PRIVATE_KEY,
        tokenUri: "https://oauth2.googleapis.com/token",
      },
    });
  });

  it("fails closed when either value is missing or unreadable", () => {
    expect(readDriveTransferConfig({ serviceAccountJson: null, parentFolderId: "0AbCdEfGhIjK" })).toBeNull();
    expect(readDriveTransferConfig({ serviceAccountJson: KEY, parentFolderId: null })).toBeNull();
    expect(readDriveTransferConfig({ serviceAccountJson: KEY, parentFolderId: "bad id!" })).toBeNull();
    expect(readDriveTransferConfig({ serviceAccountJson: "{not json", parentFolderId: "0AbCdEfGhIjK" })).toBeNull();
  });
});

describe("parseServiceAccountKey", () => {
  it("refuses keys that are not service accounts or point the token request elsewhere", () => {
    expect(parseServiceAccountKey(JSON.stringify({ ...JSON.parse(KEY), type: "authorized_user" }))).toBeNull();
    expect(parseServiceAccountKey(JSON.stringify({ ...JSON.parse(KEY), token_uri: "https://evil.example/token" }))).toBeNull();
    expect(parseServiceAccountKey(JSON.stringify({ ...JSON.parse(KEY), private_key: "" }))).toBeNull();
  });

  it("defaults the token endpoint to Google's", () => {
    const { token_uri: _ignored, ...rest } = JSON.parse(KEY) as Record<string, unknown>;
    expect(parseServiceAccountKey(JSON.stringify(rest))?.tokenUri).toBe("https://oauth2.googleapis.com/token");
  });
});
