# Cc の Web UI を Cloudflare ログイン 1 回で使う (Cernere 企業認証への相乗り)

2026-10-15 / neco 指示「Cc に CF ログインによるバイパスが出来ないか検討する。Cr による認証フローを CF をかまして作るでもいい (二重ログインを避ける)」。
方針の選択: 案 3 + 案 2 (CF のログイン先を Cernere にし、Cc は CF の JWT を Cernere で Cernere のユーザーに戻す)。

状態: 設計 (draft)。実装・設定変更・動作確認は未実施。

## 1. 結論

新しい認証の仕組みは作らない。Cernere にすでにある **Cloudflare 企業認証** (Cr `spec/feature/cloudflare-enterprise-sso.md`、#1545) に Cc を 1 つの managed project として乗せる。

- Cloudflare Access のログイン先 (IdP) を Cernere の OIDC にする。利用者は CF を通るときに **Cernere のパスキーで 1 回だけ** ログインする。
- Cc は自分の公開ホスト宛ての要求で `cf-access-jwt-assertion` を受け取り、`EnterpriseSessionClient` (`@ludiars/cernere-service-adapter`) で Cernere に渡して企業セッションを得る。Cc は JWT を自分で信用しない。
- 権限は Cernere の組織ロール (`cr_organization_role`) で決める。社員名簿 (Discord / Slack 起点の判定) は変えない。

足りないものは 3 つで、§5 にまとめる: Cernere の OIDC がメールの無いユーザーに識別用 claim を出すこと、Cc に専用の公開ホストと Host 判定を足すこと、Cc を Cernere に project として登録すること。

## 2. 現状 (2026-10-15 確認)

| 対象 | 事実 | 根拠 |
|---|---|---|
| Cc の Web UI | ログインが無い。HTTP API は loopback 専用で、Web は外側の AccessControl を通った人を全員管理者として扱う | `spec/feature/trust-boundaries.md`、`src/bootstrap/core.ts` の loopback 強制 |
| Cc の公開経路 | Excubitor の統合ビュー (viewer) 経由。外側は Cloudflare Access | `excubitor.catalog.yaml` の `viewer`、Ex `spec/feature/viewer-dmz.md` |
| viewer の中継 | `cf-` で始まるヘッダーを全部削除する。Cc には CF の JWT が届かない | Ex `src/viewer/headers.ts` |
| Cc の dots 管理口 | 公開 Host 宛てだけ CF Access の JWT を自前で検証する (Host で判定、Tailscale からは課さない) | `src/management/cf-access.ts`、`remote-config.ts` |
| Cr の企業認証 | CF のログイン先を Cr OIDC にし、custom claim (`cr_user_id` など) を Access の JWT に載せる。サービスは project WS 経由で JWT を渡して企業セッションを得る。組織所属・connection・subject 対応を毎回確認する | Cr `spec/feature/cloudflare-enterprise-sso.md`、`spec/setup/cloudflare-enterprise-sso.md` |
| Cr OIDC の email claim | ユーザーにメールがあるときだけ出す。パスキーのみ化 (Cr #2991) でユーザーはメールを持たない | Cr `server/src/oidc/scopes.ts` |
| CF Access の汎用 OIDC | 標準の `email` claim で利用者を識別する。**Email claim の名前を別 claim に変えられる**。custom claim を Access の JWT に載せられる。PKCE 対応 | [Generic OIDC](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/generic-oidc/) |
| Cr の許可制 | OIDC の同意・トークン交換・userinfo は active のユーザーだけ (Cr #2995) | Cr `server/src/oidc/provider.ts` |

## 3. 価値・シナリオ・不変条件

- 価値: **UX-CC-W2 (新設、draft)** — 利用者は Cloudflare を通るときの 1 回のログインで Cc の画面に入れ、Cc は操作した人を特定できる。二重ログインをしない。
- シナリオ
  - S-SSO-1: 外出先から Cc の公開ホストを開く → CF が Cernere のパスキー画面へ → 1 回のログインで Cc の画面が開く。
  - S-SSO-2: Cernere が落ちている → 公開ホストからは入れない。本社の Tailscale / loopback (Host が IP) からは今までどおり入れる (Cr 障害を Cc で直すため)。
  - S-SSO-3: 組織から外された・Cernere で停止された → 次の操作から公開ホストで拒否される。
- 状態の所有者: 利用者の身元・組織ロール・失効は **Cernere**。Cc は企業セッション token をブラウザの HttpOnly Cookie に置くだけで、身元を自分で持たない。
- 不変条件
  - CC-SSO-INV-01: 公開ホスト宛ての要求は、Cernere が今有効と答えた企業セッションが無ければ全部拒否する (Cernere 不通なら拒否。Cc のローカル判定へ fallback しない)。
  - CC-SSO-INV-02: `cf-access-jwt-assertion` も `Cf-Access-Authenticated-User-Email` も Cc 自身は信用しない (検証は Cernere)。後者は署名が無いので使わない。
  - CC-SSO-INV-03: loopback / Tailscale (Host が IP) の経路は今の信頼境界を変えない。公開ホストの判定はそちらに漏れない。
  - CC-SSO-INV-04: 公開ホストで許すのは組織ロールが owner / admin の人だけ (今の「通った人は全員管理者」と同じ強さ)。member は拒否する。

## 4. 流れ

```
ブラウザ → cc.<domain> (CF Access app, IdP = Cernere OIDC)
  └ 未ログイン → Cernere /oidc/authorize → パスキー → 同意 (active・組織所属を Cr が確認)
  → CF が Access JWT を発行 (custom claim: cr_user_id, amr, auth_time, cr_auth_revision, cr_connection_revision)
  → cloudflared → Cc (127.0.0.1)。Host が公開ホスト
  → Cc: Cookie の企業セッションが無い/無効なら、cf-access-jwt-assertion を EnterpriseSessionClient.login で Cernere へ
       → Cernere が署名・AUD・subject 対応・組織所属・MFA revision を確認 → 企業セッション token
  → Cc: role が owner/admin なら画面と API を通す。各要求で verify、WS は watch で失効を監視
```

## 5. 必要な変更

### 5.1 Cernere

| # | 変更 | 理由 |
|---|---|---|
| Cr-1 | OIDC に **識別用 claim** を足す: scope `email` 要求時、ユーザーにメールが無ければ `cr_access_email = <userId>@users.<Cr の公開ドメイン>` を出す (`email` は出さない)。CF の Generic OIDC で Email claim をこの名前にする | CF Access は email で利用者を識別する。パスキーのみのユーザーにはメールが無い。実在しないアドレスなので配送に使わない旨を明記する |
| Cr-2 | `/enterprise` の subject 対応付けを、`cr_user_id` で初回に自動提案する (管理者が確定する) | 今は CF の subject UUID を初回ログイン後に管理者が手で割り当てる。人数が増えると手間 |
| Cr-3 | 確認のみ: 許可制で pending の人は OIDC 同意で止まる。Cernere の画面 (/access など) は CF の外に置く (循環防止。既存手順書 §Cr の配置でも明記) | Cr #2995 |

### 5.2 Concordia

| # | 変更 | 所属 |
|---|---|---|
| Cc-1 | 公開ホスト `CONCORDIA_WEB_PUBLIC_HOST` を設定で受け、その Host 宛ての要求に企業セッションを必須にする gateway (Host 判定は dots 管理口と同じ方式) | http-interface (アダプター) |
| Cc-2 | 企業セッションの業務判断 (role が owner/admin か、失効時の扱い) を純関数のポリシーに分ける | governance ドメイン (新規宣言) |
| Cc-3 | Cernere への project WS 接続と `EnterpriseSessionClient` の adapter。Cr 不通は拒否 | adapter |
| Cc-4 | セッション Cookie (`__Host-`、Secure、HttpOnly、SameSite=Lax)。中身は企業セッション token。ログアウトで消す | adapter |
| Cc-5 | 監査: 公開ホスト経由の変更操作に Cr userId を記録 (operation 履歴の actor) | governance |

### 5.3 Excubitor / Cloudflare (運用)

| # | 変更 |
|---|---|
| Ex-1 | Cc の公開ホストを Tunnel に足し、cloudflared を Cc の 127.0.0.1 へ向ける (Ex の CF ブローカーで route と allowlist)。統合ビューは今のまま残す (中継で JWT が消えるため、統合ビュー越しの単一ログイン化は別課題) |
| Ex-2 | CF Access app (公開ホスト) を作り、IdP を Cernere OIDC だけに限定する。AUD を Cernere の enterprise connection と Cc の設定に入れる |
| Ex-3 | Cernere に Cc 用の managed project・専用 OIDC client・enterprise connection (組織 = LUDIARS) を登録する。Cc の project credential は Vault へ |

## 6. 比較した案と不採用の理由

| 案 | 不採用の理由 |
|---|---|
| Cc が CF の JWT を自前で検証し、メールで社員名簿を引く (案 1) | Cernere と別の身元管理が Cc に増える。パスキーのみのユーザーにはメールが無く、名簿との対応も新設になる |
| 統合ビュー越しに JWT を渡す | 統合ビューの DMZ は CF の JWT を検証しない設計 (Ex viewer-dmz)。Cc 1 つのためにその信頼境界を変えない |
| Cc の Web に Cernere の通常ログイン (composite) を足す | CF のログインと合わせて二重になる (指示の目的に反する) |

## 7. リスクと残課題

- Cernere の可用性: 公開ホストは Cr 不通で使えなくなる (S-SSO-2 の経路で回避)。
- custom claim は Access のサイズ制約で欠落し得る。欠落時は Cr が拒否する (既存仕様)。
- 統合ビュー経由の他サービスも単一ログインにするには、Ex 側で「統合ビュー自体を Cr 企業認証で守り、各サービスへ検証済みの身元を渡す」設計が別に要る (本書の範囲外)。
- CF の Email claim を独自名にしたとき、Access ポリシー (メールのドメイン条件) を `users.<Cr ドメイン>` で書く必要がある。

## 8. 実装の分割 (着手は neco の承認後)

| PR | リポ | 内容 | 受入条件 |
|---|---|---|---|
| 1 | Cernere | Cr-1、Cr-2 | メールの無い active ユーザーで `cr_access_email` が出る / メールのあるユーザーは従来どおり / pending は同意で拒否 |
| 2 | Concordia | Cc-1〜Cc-5 | 公開 Host + 有効セッション + owner/admin だけ通る / member・失効・Cr 不通・JWT 偽装は拒否 / loopback・Tailscale は従来どおり |
| 3 | 運用 | Ex-1〜Ex-3 | 人の承認の上で CF・Tunnel・Cr 登録を行い、公開ホストで S-SSO-1〜3 を確認 |

## 9. 未決 (neco 判断)

| 事項 | 推奨 |
|---|---|
| Cc 公開ホストの名前 | `cc.<DOMAIN_ROOT>` (既存の `cdgd-mgmt` は dots 用で別) |
| 公開ホストで許すロール | owner / admin のみ (今の「全員管理者」と同じ強さを保つ) |
| 統合ビュー全体の単一ログイン化 | 本件の後に別設計 |
