---
title: Cc経由の内部Agentモデル選定
type: feature
id: CC-INTERNAL-AGENT-MODEL
status: draft
---

# 内部Agentの選定方針

価値は UX-CC-W1/W2、シナリオは UX-CC-S1/S2。利用者が失うと困る状態は、
子への分担でも合意したモデル選定と費用管理が保たれ、委任先を追跡できること。

対象は Cc の spawnSession から新しく起動した Claude。既存セッション、直接起動、
全体設定は変更しない。Agent/Task の prompt と description を既存の
suggestForumModel に渡し、テンプレートと使用枠も既存 adapter から取得する。
独立した難易度ルールや選定用LLMは追加しない。

状態所有者: テンプレートは DelegationRepo、利用枠は既存 provider adapter、
実際の Agent 起動は Claude、Cc 委任 run は既存 delegation service。
選定 API と hook は run を作成しない。API は本文を保存しない。

不変条件:
- CC-IAM-01: Cc起動境界だけに設定を追加し、他の起動経路へ適用しない。
- CC-IAM-02: 同じタスク・候補・枠の入力は既存選定と同じモデルになる。
- CC-IAM-03: 選定失敗は説明付き停止。親モデルへの無言の継承は禁止。
- CC-IAM-04: Claude標準Agentで表現できないモデルとforkは、既存Cc委任へ誘導。
  hook内で起動せず、親が delegation_invoke を使用し受付/run IDを確認する。
  結果不明なら再送前にrunを照合する（CC-INV-03）。
- CC-IAM-05: 入力変更は permission allow を返さず、既存の許可判定を維持する。

標準Agentのmodelはopus/sonnet/haiku別名。選定された正確なmodel IDと別名の対応を
保証できないため、APIは正確なmodel IDを返し、hookはCc委任経路を使う。
これによりproviderとeffortを含め既存委任に渡し、Claudeの親effort継承の制約を避ける。
委任の際は子promptをargs.taskとして渡す。テンプレート固有の必須引数は既存schemaを確認する。
hookによる停止は委任受付ではなく、親が次のtool callで既存APIを使用する。

受入条件: 雑用/実装/レビューで既存選定との同値、候補なし・通信失敗・forkで
無言の親継承がないこと、範囲外toolは不変更、Cc Claudeだけ設定追加、既存引数保持。
source/tests対応は cc.acceptance.json。テスト実行・起動・再起動は別の許可に従う。

復旧: 本変更を戻して通常のビルド/承認済み再起動後に新規セッションを作る。
起動済みClaudeの設定を途中で除去しない。未受付のAgentは未実行として報告する。

実装配線: Lictorが自身の--settingsを末尾に追加するため、競合しないsession-only --plugin-dirでhookを渡す。設定はCc所有の一時ディレクトリで、ユーザー/プロジェクト設定を書き換えない。

実装前の所属確認はdomain membership/specRefsを読み、新規source/tests対を宣言。anatomia where --task internal Agent model selection launch hook の候補はagent-delegation/http-interface等。新境界の明示宣言を正本とする。

公式契約: https://code.claude.com/docs/en/hooks 、https://code.claude.com/docs/en/cli-reference 、https://code.claude.com/docs/en/plugins-reference 。実機Agent起動の確認は未実施。

検証状況 (2026-09-23): neco「検証を実行」の許可で実施。登録回帰57件成功（Vitest 53、node:test 4）、anatomia verify 5ゲート成功、2技能のquick_validate成功（Python UTF-8指定）、git diff --check成功。製品srcの型検査はエラーなし。test型検査は今回未変更のsrc/api/work-submission-routes.test.ts:43、src/implementation-tools/service.test.ts:40、tests/ontime-runtime.test.ts:5で失敗。今回追加ファイルの型エラーは報告なし。ビルドと実起動は未実施、サービス未反映。
