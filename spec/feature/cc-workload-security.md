# Cc workload 認可境界

- ID: CC-WORKLOAD-SECURITY / 状態: draft（相互接続・実機評価・移行は未実施）
- Task: actio:925ce186-9892-487a-b8e0-5225f2c04ec2
- Follow-up: actio:7a9649fb-f582-4082-b841-922ba798139b
- 価値: UX-CC-W1/W2/W5、シナリオ: UX-CC-S1/S2/S3/S6、不変条件: CC-INV-02/03/07

## 所属・所有者

既存 federation ドメインへ security の純粋な認可ポリシー、要求認可 use case、Cr/署名/nonce adapter を追加する。HTTP ブラウザ検査は http-interface に所属し、いずれも同じディレクトリに対のテストを持つ。
Cr が workload identity・grant・失効の正本。Cc の管理者配備ファイルがローカルの許可上限と送信先の正本。site registry、departments、Villa 対応、接続 URL は運用情報であり grant ではない。
workload は `site/concordia` と `site/excubitor` を区別する。旧共有 token はリンク互換用に限り、高権限認可には使用しない。

## 契約

C-21 authorizeWorkloadClaims(input): sender・audience・action・resource が管理者許可と Cr grant に一致し、有効期間が最大60秒の workload claims だけを許可する。
C-22 verifyWorkloadProof(input): Ed25519 proof は version・method・path/query・timestamp・nonce・本文・audience・token を束縛し、変更された要求を拒否する。
C-23 localBrowserDecision(input): 明示許可されない Host/Origin、cross-site要求、JSON以外の変更要求を拒否する。
C-24 authorizeWorkloadRequest(input): 毎回オンライン失効確認し、期限・proof・永続 nonce を確認できない要求では副作用を許可しない。

## Wire と操作

Cr token/introspection は Ex の `SPEC-SECURITY-MESH-CR-AUTH` と同じ JSON 契約。HTTPS 必須、redirect 禁止、5秒 timeout、応答128KiBまで。受信 Cc 自身の credentials で毎回 introspection し、active 結果をキャッシュしない。
proof は Ex 互換の `excubitor-cr-v1` JSON 配列と `x-excubitor-*` ヘッダ。秘密鍵は送信 workload のみが持つ。token は最大60秒、proof は30秒窓。nonce は SQLite の一意制約で token 期限まで保持し、再起動・同時要求で再利用できない。

| 入口 | action | resource |
|---|---|---|
| event payload 内の署名 envelope | ai-spawn / ai-inject | `thread:<guild_id>:<channel_id>` |
| PUT /v1/federation/site | hq-config | `service:concordia` |

event envelope は `{type:'workload-event', body:<元payloadのJSON文字列>, headers:<proofヘッダ>}`。署名上の method は POST、path は `/federation/event`。本文から導いた操作・資源を認可する。受信した接続先を sender と信頼しない。管理者ファイルの inbound grant により HQ workload を固定する。
HQ は outbox の元payloadを配送する直前に token/proof を生成する。署名 envelope や期限付き token を outbox に保存しない。送信不可・認可拒否は自動的にローカル spawn や旧認証へ戻さない。再送は受理済み nonce を拒否し、spawn の既存 thread 台帳も再起動を抑制する。結果不明時は既存セッション・threadを人間が照合してから再依頼する。認可後の停止・接続置換も実行前に検出する。

### 配送結果の区別 (UX-CC-W2/W5, CC-INV-03)

拠点は受信イベントごとに配送結果を 1 つ決め、ack を「処理済み」だけに使う。認可を通らなかった依頼を ack で黙って outbox から消さない。

| 結果 | 該当 | 拠点の応答 | 本社の扱い |
|---|---|---|---|
| accepted | 認可・要求台帳受理後に handler へ渡した | ack | outbox から削除 |
| duplicate | 要求台帳に同じ依頼が受理済み (署名更新の再配送) | ack | outbox から削除 |
| retry | Cr 到達不可・応答異常、proof の時刻窓超過 (拠点側の待ち)、接続所有権の喪失、nonce/台帳の保存失敗 | ack しない。接続を 1013 で閉じる | outbox に残し、再接続後に新しい token/proof で再配送 |
| rejected | envelope 不正、grant 不一致、Cr が inactive を返した、署名不一致、nonce 再利用、設定不在、台帳上限、handler 失敗 (結果不明) | `event-rejected` (seq と理由コード) | outbox から退避表 `federation_outbox_rejected` へ移し、エラーチャンネルへ拠点・seq・理由・依頼種別を通知 (本文は出さない) |

retry は同じ接続で後続を処理しない (累積 ack で先行依頼を消さないため)。rejected の退避と後続の ack は同じ接続上の順序で処理されるので、後の累積 ack が退避前の行を消すことはない。退避表は自動削除せず、管理者が照合して再依頼する。理由コードは Cr 応答本文・token を含めない。

互換: 旧本社は `event-rejected` を未知フレームとして捨てるため、旧本社 + 新拠点では従来どおり後続 ack で消える。本社を先に更新し、拠点を後から更新する。新本社 + 旧拠点は従来どおり常に ack が届く。

## 配備と復旧

`CONCORDIA_WORKLOAD_SECURITY_FILE` は管理者専用 JSON（UI/API から編集不可）。`local` は subject/clientIdEnv/clientSecretEnv/privateKeyEnv、`authority` は tokenUrl/introspectionUrl、`inbound` は subject/action/resource の完全一致配列、`sites` は site id → workload audience の写像。未設定・不正設定は remote spawn/inject/HQ変更を拒否し、既存のローカルプロセスは停止しない。設定変更は明示的な再配備・再起動で適用する。
cr-v1 イベントは WSS のみ。HQ listener の証明書は `CONCORDIA_FEDERATION_TLS_CERT_FILE` と `CONCORDIA_FEDERATION_TLS_KEY_FILE` から配備する。旧 ws のリンク監視は維持できるが、高権限イベントを配送・実行しない。HQ変更はローカル Ex → Cc の loopback 呼び出しでも新しい Cc audience の token/proof が必要。Exで検証した別 audience の token を再利用しない。この caller 移行が済むまで旧 provisioning は拒否される。

移行順: 管理承認 → Cr の拠点別 Cc/Ex 登録・鍵/grant 配備 → Cr action語彙 ai-spawn/ai-inject/hq-config の突合 → WSS/証明書と時刻同期確認 → テスト実行承認と相互接続試験 → peer単位切替 → 旧共有鍵撤去。失敗時は remote高権限を無効のまま保持し、旧認証へ戻さない。live key、enrollment、CF、稼働設定は本変更で触らない。

#### 既存運用を止めない配備順 (2026-10-09 調査結果の反映)

各段は前段の確認が取れるまで進めない。どの段で止まっても、既存のローカル起動・一般ログイン・監視は動き続ける。

1. **Cr を先に、一般認証を変えずに配備する。** workload 用 TLS は workload 経路だけの別リスナーにし、既存の認証 API / WebSocket の待受 (HTTP/WS) とプロキシ転送先・ヘルスチェックを変えない。追加 migration は本番 DB の複製で事前に流して成否を確認し、失敗時の戻し方 (直前 build + DB スナップショット) を用意してから配備する。
2. **Cr に拠点別の主体・鍵・grant を登録する。** この時点では誰も新方式を使わないので、既存運用への影響はない。
3. **Ex を監視維持の設定で配備する。** `legacy-monitor` を明示して health/node の監視を継続する。Vault の遠隔取得が一時障害で失敗したときの起動可否をサービス別に確認し、秘密を要するサービスの再起動はこの段では行わない。キュー待ちでの認可期限切れと bundle digest 承認の運用を決めておく。
4. **Cc 本社を配備する。** 本社は `event-rejected` を受けて退避表へ移せる版を先に入れる (旧拠点からは従来どおり ack が届くので無害)。listener の TLS 証明書を配備し、プロキシで TLS を終端して平文転送する構成は使わない。`CONCORDIA_LOCAL_ALLOWED_ORIGINS` に既存の公開 URL を入れ、本文なしの変更要求に JSON ヘッダーを付けていない呼出元を洗い出す。
5. **Cc 拠点を 1 拠点ずつ切り替える。** 新しい拠点 Cc + workload 設定を入れ、遠隔 spawn/inject の実接続試験で accepted・duplicate・retry・rejected の各結果を確認してから次の拠点へ進む。退避表に行が入ったら原因を照合してから再依頼する。
6. **全拠点の切替後に旧共有鍵を撤去し、`legacy-monitor` を外す。**

この順序では、手順 4 以前に Cc の拠点を更新しない。旧本社 + 新拠点の組合せ (拒否が従来どおり後続の ack で消える) を作らないためである。

## ローカルブラウザ境界

本体 Hono app の先頭で Host/Origin/Fetch Metadata を検査し、変更要求は application/json を要求する。既定 Host は localhost/127.0.0.1/[::1]。既存 Access 公開 UI や開発 UI は管理者の `CONCORDIA_LOCAL_ALLOWED_ORIGINS`（カンマ区切りの完全 origin）に明示する必要がある。Forwardedヘッダを信頼しない。WebSocket upgrade も同じブラウザ検査が必要。
これはローカル悪性プロセスや SSRF の認証ではない。一般管理 API の利用者別 credentials 移行は未解決で、全管理API認証が完成したとは扱わない。

## 検証

読み取り照合時点の Cr counterpart `server/src/workload/input.ts` は ai-spawn/ai-inject/thread 資源を未許可。親委託へ差分を報告済みであり、Cc側からCrファイルは変更しない。Crでこの語彙が管理者grantとして承認されるまで該当操作は拒否される。

受理済み業務依頼は `federation_workload_requests` に sender/audience/resource と spawn channel または inject message ID を保存する。署名を更新した再配送でも再実行しない。副作用前の記録後に停止した場合は結果不明として照合が必要。台帳は自動削除せず100万件で新規受理を拒否し、管理者の照合・アーカイブ手順を要する。認証nonceは期限切れだけ削除する。

Augur plan の一般的な「log-onlyへ緩和」は本変更のfail-closed要件に反するため採用しない。権限の配備・正式なcaller移行で復旧する。

Augur計画と対の回帰テストを追加する。テスト実行禁止のため未実行・契約未観測を維持する。Cr相互接続、実機UX、停止途中の副作用、運用cutoverは未検証。
