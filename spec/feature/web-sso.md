---
type: feature
title: "Web UI の公開ホストを Cloudflare ログイン 1 回で使う (Cernere 企業認証)"
service: concordia
domain: web-access
status: implemented
updated: 2026-10-15
related:
  - ./trust-boundaries.md
  - ../plan/2026-10-15-cf-cernere-sso.md
---

# Web UI の公開ホストを Cloudflare ログイン 1 回で使う

設計: [../plan/2026-10-15-cf-cernere-sso.md](../plan/2026-10-15-cf-cernere-sso.md) (PR #3003)。
Cernere の Cloudflare 企業認証 (Cr `spec/feature/cloudflare-enterprise-sso.md`) に Cc を 1 つの managed project として乗せる。

## 価値・シナリオ

- UX-CC-W10: Cloudflare を通るときの 1 回のログイン (Cernere のパスキー) で Cc の画面に入れ、Cc は操作した人を特定できる。二重ログインをしない。
- UX-CC-S11: 公開ホストを開く → CF が Cernere のパスキー画面へ → 1 回ログイン → Cc の画面。Cernere 不通のときは公開ホストは拒否し、本社の Tailscale / loopback からは今までどおり入れる。組織から外れた・停止された人は次の要求から拒否される。

## 状態の所有者

利用者の身元・組織ロール・失効は Cernere が持つ。Cc は企業セッション token を `__Host-cc-sso` Cookie (Secure、HttpOnly、SameSite=Lax) に置くだけで、身元を保存しない。

## 不変条件

- CC-SSO-INV-01: 公開ホスト宛ての要求は、Cernere が今有効と答えた企業セッションが無ければ拒否する。Cernere 不通も拒否 (ローカル判定へ fallback しない)。
- CC-SSO-INV-02: `cf-access-jwt-assertion` は Cc 自身では信用せず、Cernere へ渡して検証させる。`Cf-Access-Authenticated-User-Email` は使わない。
- CC-SSO-INV-03: loopback / Tailscale (Host が IP) の経路は今の信頼境界のまま。Host が公開ホストでなくても、トンネル由来のヘッダー (`cf-ray` / `cf-connecting-ip` / `cf-access-jwt-assertion`) があれば公開側として扱う。
- CC-SSO-INV-04: 公開ホストで通すのは組織ロールが owner / admin の人だけ。

## 設定

| env | 意味 |
|---|---|
| `CONCORDIA_WEB_PUBLIC_HOST` | 公開ホスト名。無ければ機能は無効 |
| `CERNERE_URL` | Cernere の URL (Excubitor が配る) |
| `CONCORDIA_CERNERE_PROJECT_KEY` / `_CLIENT_ID` / `_CLIENT_SECRET` | Cernere の managed project の資格情報 (Vault) |

公開ホストを有効にして Cernere の情報が欠けていれば起動を止める。

## 境界と戻し方

- HTTP: `buildApp` の先頭ミドルウェア。WS: `/ws` の upgrade で同じ判定。
- 戻し方: `CONCORDIA_WEB_PUBLIC_HOST` を外すと今までの動作 (公開ホストは無い) に戻る。
