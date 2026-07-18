# Long-running Codex/Claude CPU and transcript storage investigation (2026-07-18)

## Scope

2026-07-17夜から、Windows再起動直前の2026-07-18 09:37 JSTまでを調査した。根拠は `concordia.db.host_metrics` 1,402 samples、Windows System event、Concordiaの修正履歴、Codex/Lictorのローカル状態と実装である。

## Findings

### 1. 主因は長寿命sessionとnested spawnのプロセスfan-out

- 18時台は約12 session / 約72 session-tree processes / 約8.1GBで、host CPU平均55%。
- 01〜04時台も約9 session / 約57 processesが残り、Codexが0件の時間でもClaude 16件とNode約55件によりCPU約40%が継続した。
- 05:36のピークはhost CPU 100%、OS実数で `node.exe` 90件/8.2GB、`claude.exe` 18件/6.8GB、`MsMpEng.exe` 1.17GBだった。
- 同時刻の親Lictor treeは最大136 descendantsを包含した。短時間に多数のproject labelへ変化しており、nested/batch spawnの子孫が親treeへ集積したものと判断する。
- CPUとの相関はCodex process count 0.596、tracked RSS 0.476、session count 0.458、tracked process count 0.451。単一プロセスの経時劣化より、残存session数とfan-outの影響が強い。

session treeは親子で同じdescendantを重複集計しうるため、tree process sumはOS実数として扱わない。上記ピークではOSのprocess-name別集計も併記した。

### 2. 既知のCodex transcript全量走査が負荷とevent-loop stallを増幅していた

2026-07-17 06:32 JSTのcommit `f20ab49` は、`~/.codex/sessions` 8,553 JSONL / 1.48GBを `readFileSync` で全量走査し、10分周期で20〜110秒event loopを停止させていた問題を修正している。現在は先頭64KB、最新日付優先、正負cacheへ変更済みである。

今回の状態は8,849 files / 約1.67GBまで増えており、この修正前の処理が長期稼働時に悪化する条件と一致する。ただし05:36のCPU 100%時のevent-loop maxは約65msであり、再起動直前の継続CPUは全量走査だけでは説明できず、process fan-outが主因である。

### 3. 終了残骸のcleanupが不十分

再起動後のhost metricsでも、`lost` statusの2 sessionにlive PIDと11〜15 descendants、各約0.7GBが残っていた。さらにCodex rollout横のLictor claimは142個あり、131個が24時間超、直近5分以内は6個だけだった。

Lictorは正常stop時にclaimを削除するが、crash残骸は同じJSONLを別wrapperがclaimするときにだけstale removalされる。古いsessionには再訪がなく、sidecarが残り続ける。lost session treeの終了とstale claim cleanupを別途実装候補とする。

### 4. Defenderのconfig.toml監視は検出ではなくon-accessの可能性が高い

- Defender Operational logに `config.toml` の検出・隔離eventはなかった。
- `config.toml` は8.9KBで、最終更新は07:55。多数のproject trustとhook trusted hashを持ち、各Codex起動時に読み込まれるglobal設定である。
- Defender real-time/on-access protectionは有効。多数のCodex起動が同じ設定を読むため監視対象になるのは通常動作で、ファイル単体の容量からCPU主因とは考えにくい。
- 実際の高I/O対象は、常時更新される `logs_2.sqlite` 約1.27GBとWAL、`state_5.sqlite` 約97MB、session JSONL約1.67GBである。05:36のDefender RSS増加も大量のagent/Node活動と同時だった。

`.codex`全体や`config.toml`をDefender除外にすることは、hook/MCP/approval設定の改変検知まで失うため推奨しない。必要ならDefender Performance Analyzerでpath別I/Oを採取してから、限定的な除外を判断する。

## Lictor-compatible transcript partitioning

推奨はCodex 0.144.5の公式 `codex archive <session-id>` / `codex unarchive <session-id>` を使うsession単位のcold archiveである。

1. Concordia sessionがended/lostで、Lictor PIDが停止済みであることを確認する。
2. `<rollout>.jsonl.lictor-claim` が解放済みであることを確認する。残骸はowner sessionがinactiveかつPID deadの場合だけcleanupする。
3. grace period後に `codex archive <session-id>` を実行し、active `~/.codex/sessions` treeから `archived_sessions` へ退避する。
4. resumeが必要なら `codex unarchive <session-id>` で戻す。

動作中JSONLの途中分割・移動は行わない。Lictorは束縛後の絶対pathとbyte offsetをpollし、隣接する `.lictor-claim` をrefreshするため、active fileの移動はrelay停止やclaim残骸を生む。また、session別 `CODEX_HOME` shardingはLictorのCodex transcript rootが `~/.codex/sessions` 固定であるため、現状は非互換である。

## Follow-up candidates

- ended/lost sessionのPID treeを確実にreapし、live descendantsが残れば可視化する。
- stale claimを、owner inactive + PID deadの条件で定期cleanupする。
- ended sessionをgrace period後にCodex公式archiveへ送るretention jobを追加する。
- host metricsへprocess単位CPUとparent/child重複を除いた一意PID集計を追加する。
