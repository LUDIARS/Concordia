---
title: 対象と会話の確証に応じた主要 Inject
service: concordia
domain: session-coordination
status: implementation
---

# 対象と会話の確証に応じた主要 Inject

主要 Inject を「基本」と「拡張」に分ける。基本は全 session に共通して届く作業・協調文である。拡張は機械的な適用条件が揃った場合にのみ基本へ加算する。DDD、Pf、An は互いに独立した拡張であり、複数一致した場合はすべて加算する。自由記述の判定ルールや動的な実行 DSL は設けない。

価値は UX-CC-W1（作業対象を取り違えない）、UX-CC-W4（必要な判断だけを通知する）、UX-CC-W5（古い非同期結果を採用せず復旧できる）。CC-INV-01/04 と CC-NODE-01/02 を守る。Cc の共通起動文・通常/エスカレーション協調文・委託文には、DDD、Praeforma、Anatomia の対象固有の追加案内を無条件に含めない。許可・承認・ゲートの条件は案内の有無で変えない。

## 判定と配達

- 最初の実人間会話を確証でき、かつ現在の session が実対象 repository に明示的に bind された後でだけ、対象固有の案内を評価する。初回 cwd、推定 project code、transcript の `role=user`（自動 Inject の echo を含む）、発話主体不明の `prompt` event は、それ単独では証拠にしない。現在確証できるのは Discord/Slack の発話者を含む正規の Inject source のみである。ローカル provider は人間入力と自動初期 prompt を区別する provenance が現行 hook に無く、追加の証拠契約ができるまで条件付き注入をしない。
- DDD の手順・成果報告は、対象 project-code registry の `ddd_enabled === true` を確認した場合だけ出す。`false`、未登録、不明では出さない。DDD 以外の必須設定（契約・テスト・オンタイム）は、対応する手順だけを出せる。共通 header/report に DDD の語を混ぜない。
- Praeforma と Anatomia は独立に判定する。各サービス所有 catalog から接続先を得て、対象 Git repository に一意に結び付く現行 project 登録と実在する API 参照 endpoint を照合できた側だけ、その実 API URL と案内を出す。利用者ブラウザ向け WebUI URL とは称しない。ID・URL・repository の名前を推測しない。一方の未登録・停止・応答不明は他方の成功を取り消さない。
- 委託指示書のドメイン先行前置きは、確証済み会話・明示 bind に加え、対象 project の `ddd_enabled === true` と対象 repository に一意に照合した Anatomia project ID・API 接続先が揃う場合だけ出す。照合済み接続先で横断検索と plan を行い、他 project の hit は除外する。該当 ID の hit が無ければ前置きを出さない。検索・plan の待機後にも bind と DDD 状態を再確認し、切替後の結果は捨てる。一般の An 参照拡張は DDD 条件と独立させる。
- Pf project 一覧は最大 300 件まで照合し、上限を超えた場合は推測して選ばず Pf 案内を見送る。個々のHTTP照会は2.5秒、An登録照合は4秒、その後のAn/Pf独立照合は各8秒の上限を設ける（全体最大12秒）。片側の期限切れで、確認に成功した他方の案内を消さない。
- 明示 bind と対象の変更ごとに再評価する。非同期照会の前後で session ID、repo path/origin、branch、target project と明示 bind 証拠を照合し、旧対象の遅延結果を捨てる。対象変更時は前版の対象固有案内を明示的に撤回し、新版が空の場合も撤回通知を出す。同じ版は再送しない。配送キュー投入を相手の読了と偽らない。

## 手動調整済み文面

WebUI で編集された主要本文を既定文へ戻さない。既知の旧 DDD/Pf/An 定型文が手動本文に混入している場合に限り、対象 ID・現行 revision・完全一致する定型 fragment を照合して分離する。元全文を履歴 baseline に保存してから、分離後の本文を `context_migration` として新版へ記録する。任意の自由文を正規表現で消さない。認識できない混入は自動修正せず、編集者に対象 scope を示して判断を委ねる。条件付き fragment は本文 override と別の policy field で配達し、手動文面の改版を失わせない。

## 受入条件

1. 初期起動、初回 cwd のみ、未確証会話、未確証 bind、未登録 project では対象固有の DDD/Pf/An 文・Anatomia 必須探索文を送らない。
2. DDD=false でも他の必須設定が true なら DDD header/report なしに必要手順を送る。DDD=true の確定対象だけ domain/value/specRefs 等を案内する。
3. Pf と An の片方だけが登録・URL 照合成功した場合はその片方だけを案内し、両方失敗ならどちらも案内しない。
4. 対象を切り替えると古い案内を撤回する。並行・遅延照会、同一版の反復確認では旧対象の再注入・重複注入をしない。
5. 手動 override の既知定型 fragment 移行では全文履歴と編集差分を残す。未知の自由文は変更しない。

テストは記述する。実行・サービス操作には別途人間の許可を要する。
