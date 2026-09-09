# 通常 Codex spawn の初期依頼と対話寿命

- ID: CC-INTERACTIVE-CODEX-STARTUP
- Domain: delegation-provider
- UX: UX-CC-W2 / UX-CC-W3

## 利用場面と不変条件

Discord フォーラムの起動依頼や通常 spawn の初期本文を処理した後も、同じ Session で
確認回答・追加指示を受け付ける。ターン完了は Session 終了を意味しない
（INV-CC-INTERACTIVE-TURN）。Session 行の終了状態は既存 session-lifecycle が所有する。

`admin/spawn-session` の provider 直指定と `template + inject_prompt:false` は通常起動。
`inject_prompt:true` は実際の delegation invoke へ渡される一回実行であり、この規則の対象外。

## 実行契約

通常起動の provider が `codex` の場合、Cc は `LICTOR_CODEX_TRANSPORT=legacy` を明示する。
これは Lictor の既存 PTY 対話経路の選択であり、障害時の暗黙フォールバックではない。
初期本文の有無から実行寿命を推測させない。

初期本文ファイルは互換性のため既存 `CONCORDIA_DELEGATION_PROMPT_FILE` で渡す。
Lictor の legacy 経路はこれを初期入力として配送し、ターン後も PTY を維持する。
ファイル名・環境変数名に delegation が含まれていても、通常起動の寿命は対話として明示する。
他 provider の設定、真の delegation の App Server 終了契約、プロジェクト認可境界は変更しない。

この選択は `control/interactive-spawn-env.ts` の純関数が所有し、API の両通常起動経路から使う。
環境変数の大域変更や既存セッションへの transport 切替は行わない。効果は反映後の新規起動から。

## 検証・復旧

回帰確認の対象は provider 直指定、template通常起動、真のdelegation、初期本文なし、
初回回答後の追加入力、明示終了、初期本文の配送である。テストは今回未実施。
反映はバックエンドの変更なのでビルド成果物の更新と Excubitor 経由の再起動が必要。
不具合時は退避した成果物を戻し、同じ経路で再起動する。終了済みセッションは自動で復活しない。
