---
id: CC-ORBIS
type: feature
domain: browser-bridge
status: draft
task: actio:262ba08f-20e5-4125-b2d5-4047a386c060
related_tasks:
  - actio:bcbe7198-0b50-4c48-bcac-ab45f6874fe3
---

# Orbis Vinculum クライアント

UX-CC-W1/W5、CC-INV-02/04/05/07 を対象とする draft。人間が指定したページを
セッションが読み、必要なクリック・入力を行って作業を継続する。人間承認・実機評価は未実施。
既存の cloud-work は変更しない。既存の ExcubitorClient / resolveServicePort と
セッション MCP の HTTP 呼出しを再利用する。汎用 HTTP ドメインは公開面だけを所有し、
新しい支援ドメイン browser-bridge が入力判断・Orbis 接続手順を所有する。

## 用語・所有者と不変条件

- sigillum: 人間が Orbis のアドレスバーの 🪪 から渡すページ権限。推測・列挙しない。
- client id: 呼出し元 Cc session id。attach 所有権・ページ状態は Orbis が所有する。
- instance id: Excubitor の concordia service_detail の instance_id。Cc が生成しない。
- CC-ORBIS-01: 存在する active/blocked セッションだけが操作し、client id を別入力で上書きできない。
- CC-ORBIS-02: ポートは Excubitor の orbis catalog 宣言を優先する。宣言 (`catalog_snapshot.port !== undefined`) があればその値だけを検証し、null・不正値は `orbis_unavailable` として観測値へ戻さない。宣言が無い場合だけ観測値を検証する。共有トークンは env 読取りのみ。
- CC-ORBIS-03: act は click/type/scroll/select のみ、type.text は 1〜2000 文字。
- CC-ORBIS-04: reveal にはこのセッションへ届いた人間発話の実在 ID の証明が必要。
- CC-ORBIS-05: 生の外部例外・トークン・ページ本文・URL query をログやエラーに残さない。

接続先の判断は browser-bridge の純関数 `resolveOrbisEndpoint` が所有し、I/O は既存の
ExcubitorClient に残す。Actio transport と同じ宣言優先規則を使い、共通の
`resolveServicePort` は変更せず選択した値の検証に再利用する。Electron の別 listener の
観測値へトークンを送らないための境界であり、catalog 宣言・観測値は Excubitor が所有する。
宣言不正時は人間が catalog を修正してから再試行する。Cc が別ポートを推測しない。

## API

POST `/v1/orbis/{attach,detach,open,navigate,read,act,logs,reveal}`。
JSON は session_id と sigillum 必須、32,000 bytes 上限、未知フィールドは拒否する。
open は url と visible (既定 false)、navigate は url、read は mode
(text/dom/a11y/screenshot、既定 text)、act は action、logs は since?、
reveal は userUtteranceId を受け取る。URL は http/https のみ。
MCP は同名の `orbis_` ツールを提供し、wrapper の session id を使う。
search / toMemoria は公開しない。

`Authorization: Bearer <env token>`、`x-orbis-client-id: <session id>`、
`x-orbis-instance-id: <Excubitor instance_id>` で Streamable HTTP POST `/` を使う。
呼出しごとに接続して必ず close し、通常15秒、screenshot読取り30秒を上限とする。
失敗語彙は orbis_token_missing / orbis_unavailable / orbis_unauthorized /
orbis_operation_failed / orbis_invalid_request / orbis_reveal_requires_user_utterance のみ。
成功時の MCP content はページ読取り結果として呼出し元へ返すが、Cc は永続化・ログ出力しない。

### reveal の制限

既存 session_messages は transcript の user role も受理し、session.inject に安定した
外部 message ID がない。reaction provenance は外部 ID の hash を保持するが、人間の直接発話を
証明しない。このため既存の表示用 author_type=user や任意の文字列を証拠にせず、
reveal は常に orbis_reveal_requires_user_utterance で拒否する。
残件: 人間の直接発話とセッションへの配達を証明する ID 台帳が導入された際の連携。

## 設定・復旧

人間が Excubitor「環境変数」で ORBIS_VINCULUM_TOKEN を Vault に登録し、orbis と
concordia の両方へ binding する。AI は実値を生成・閲覧・記録しない。
人間が Electron Orbis で対象サイトへログインし、🪪 の sigillum をセッションへ渡す。
Cc が instance id を送る構成の反映後、Orbis の peer verification を人間が有効化する。
環境変数変更の反映は別途承認されたサービス操作で行う。

通信切断・タイムアウト後の副作用は結果不明として自動再試行しない。
read/logs で状態を照合し、必要なら人間がページを確認してから続ける。
attach の継続可否は Orbis が判断し、Cc はローカル所有権の複製を作らない。
Cc の再起動で偽の attach 状態を復元しない。不要な権限は detach し、
緊急停止時は Vault binding の撤去と Orbis 側の権限無効化を人間が行う。

## 契約と検証計画

C-1 parseOrbisRequest(operation,input): 公開8操作と許可した action だけを受理し type.text は2000文字以下。
C-2 resolveOrbisEndpoint(orbis,concordia): catalog宣言があればその値のみ検証し、宣言が無い場合だけ観測値を使い、有効なCc instance_idを伴うloopbackだけを返す。
C-3 publicOrbisError(error): 外部例外を含めエラーは閉じた6語彙だけを返す。
C-4 authorizeOrbisRequest(session,operation): active/blocked以外と、証明台帳のないrevealを拒否する。

偽 transport による token/client-id/instance-id、401/接続不可/期限、資源解放、
別セッションの所有権拒否を検証する。HTTP と MCP の session 検証・body上限も検証する。
単体テストと tsc 2本まで。実 Orbis 接続、LINE等への送信、サービス起動・再起動は行わない。
