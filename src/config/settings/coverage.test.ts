/**
 * W5-4: 未露出の設定を検出する回帰テスト。
 *
 * ソースに現れる env 名 / DB 設定キーがレジストリに登録されていなければ落ちる。
 * 「また WebUI に出ていない設定が増える」 を構造的に止めるのがこのテストの役目なので、
 * 落ちたときの正しい対処は **除外リストに足すことではなく定義を書くこと**。
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { registeredDbKeys, registeredEnvNames } from "./definitions/index.js";
import {
  DB_KEY_COVERAGE_EXCLUSIONS,
  ENV_COVERAGE_EXCLUSIONS,
  scanSourceSettingKeys,
} from "./coverage-scan.js";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("設定レジストリのカバレッジ", () => {
  const scanned = scanSourceSettingKeys(SRC_ROOT);

  it("ソースが読む env は全てレジストリに登録されている", () => {
    const registered = registeredEnvNames();
    const missing = [...scanned.envNames]
      .filter((name) => !registered.has(name))
      .filter((name) => !(name in ENV_COVERAGE_EXCLUSIONS))
      .sort();

    expect(
      missing,
      `レジストリ未登録の env があります。 src/config/settings/definitions/ に定義を足してください` +
        ` (Concordia の設定でないものだけ ENV_COVERAGE_EXCLUSIONS に理由付きで追加): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("ソースが使う DB 設定キーは全てレジストリに登録されている", () => {
    const registered = registeredDbKeys();
    const missing = [...scanned.dbKeys]
      .filter((key) => !registered.has(key))
      .filter((key) => !(key in DB_KEY_COVERAGE_EXCLUSIONS))
      .sort();

    expect(
      missing,
      `レジストリ未登録の DB 設定キーがあります: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("走査が実際にキーを拾えている (空振りで緑になっていない)", () => {
    // 走査が壊れて 0 件になると上の 2 つが常に緑になる。 それを検出する番人。
    expect(scanned.envNames.size).toBeGreaterThan(50);
    expect(scanned.dbKeys.size).toBeGreaterThan(10);
  });

  it("除外リストは実在するキーだけを挙げている", () => {
    // 消えたキーの除外が残ると、 同名の設定を後から足したとき黙って見逃す。
    const staleEnv = Object.keys(ENV_COVERAGE_EXCLUSIONS)
      .filter((name) => !scanned.envNames.has(name))
      .sort();
    expect(staleEnv, `ソースに現れない env の除外が残っています: ${staleEnv.join(", ")}`).toEqual([]);
  });
});
