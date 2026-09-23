---
title: Windowsの短命ウィンドウとフォーカス移動の調査
type: feature
id: CC-WINDOWS-CONSOLE-FOCUS
status: investigating
---

# 2026-09-23 調査記録

人間報告: コマンド/テストのたびにウィンドウが一瞬出て消え、フォーカスが奪われる。
windowsHide:trueへ変更したとの前回報告後も再発。解消済みという判断を撤回。

## Windowsイベントの根拠

- Windows PowerShell、Event ID 400、Record 16823997、12:35:02.043 JST、PID 89632:
  powershell.exe -NoProfile -Command node "E:/Document/Ars/Concordia/tools/concordia-hook.mjs" tool-result --provider=codex-cli
- 同じ起動を12:30:09〜12:35:02の複数時点で確認。登録元はC:/Users/raury/.codex/hooks.jsonのPostToolUse、matcher .*。
  Ccフックのため、テスト本体の起動を非表示に変えてもフックを起動する外側のPowerShellにはその指定が届かない。
- Event ID 4104、Records 7568398/7568171/7567947: Memoriaのforeground samplerと一致。
  12:33:16、12:32:46、12:32:16に30秒間隔。現行ソースのexecFileにはwindowsHide:trueあり。
- 12:26:52〜12:34:49の8分窓でExcubitor process identityに一致するEvent ID 400が1188件。
  src/shared/exec.tsとdist/shared/exec.jsにはwindowsHide:trueあり。頻度だけで表示原因とは断定しない。
- Security 4688は指定期間で該当イベントなし。Sysmon/Operationalチャネルなし。

## 確定範囲と残件

イベントログは起動内容・時刻の証拠であり、作成フラグや実際のフォーカス移動の証拠ではない。
Cc PostToolUseの外側の起動が有力候補。Windowsプロセス一覧でCodex command runner配下の
conhostも観測したが、conhostの存在だけでは可視性を証明しない。
Windows画面一覧の取得はComputer Use native pipe unavailableで失敗した。

修正は外側のhookランナーの非表示起動、または既存Cc処理を保持した非console transportが必要。
内側のコマンドへさらにHiddenを付けるだけでは根治と扱わない。hookはreliabilityの状態観測と
additionalContextを返すため、単純無効化はしていない。グローバル設定変更・監査無効化・
プロセス強制終了・サービス再起動は未実施。実際の非表示化とフォーカス維持は未確認。

公式の代替経路: https://learn.chatgpt.com/docs/hooks#MCP-tool-hooks
既存MCP接続でhookを実行できるが、現Cc用handlerの準備と結果互換性の確認が必要。
