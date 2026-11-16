---
task: control-child-reaper
project: Concordia
kind: 実装
status: done
created: 2026-11-16T08:20:00.000Z
source_session: lictor-9fd85ee4-d7cd-4814-afe4-a93092a3fdbd
memoria_task_id: null
pr_number: null
actio_task_id: null
memory_links: []
---
# 管制に、作業指示で起動した子セッションの片付けを足す

設計正本: `spec/feature/control-session.md` §9、不変条件 CC-CTL-INV-08。neco 指示 (2026-11-16)「セッションから作業指示で起動したセッションが反応してないか役目を終えた際に閉じる役割も持つ」。

## 変更した境界

- `src/control-session/reaper-policy.ts` (新規・純関数): 子の判定 (`classifyChild`)、閉じてよいか (`decideReap`、理由コードを返す)、2 段の段取り (`nextReapStep`)。
- `src/control-session/reaper-facts.ts` (新規): 待ち・審査中 PR・testing claim・未保存の変更・委託 run の終端の受け取り・リポ担当 PR の merged を既存の所有者から読む。照会できないものは null にして閉じない側へ倒す。
- `src/control-session/reaper.ts` (新規): 案内 → 10 分の猶予 → 既存の終了経路 (`DELETE /v1/sessions/:id`)。親への inject と管制チャンネルへの通知。終了の結果が分からなければ再送しない。
- `src/control-session/runtime.ts`: 管制が ON の巡回で片付けを回す (失敗は警告ログ、巡回は止めない)。
- `src/bootstrap/core.ts`: 既存部品で配線 (delegation_runs / session_events / resident_sidecars / testing claims / Revisor / git / endSessionNow と同じ DELETE 経路)。
- 設定 `session.control_session_reaper_enabled` (既定 ON、`runtime-settings` / `state` / `definitions/session.ts`)。

## 判断した点

- Cc には「反映済み」の記録が無い。リポ担当の「役目を終えた」は Revisor PR の merged と 30 分の無会話で判定し、反映中は testing claim を持つこと (閉じない条件) で守る。
- 委託 run の終了後の子の片付けは既存の `admin.delegation_finished_run_auto_reap` もあるが、どちらも同じ終了経路を通り、二重でも安全 (`endSessionNow` は ended を再処理しない)。

## 復旧方法

- 止める: `session.control_session_reaper_enabled` を OFF (次の巡回から止まる)。管制ごと止めるなら `session.control_session_enabled` を OFF。
- コードを戻す: この PR を revert。子 metadata の `control_reaper` は記録だけで、他の処理は読まない。

## 検証

- 実施: `vitest run` で reaper-policy / reaper-facts / reaper / runtime / admin runtime-settings (32 件成功)、`tsc --noEmit` (tsconfig.json / tsconfig.test.json で変更ファイルに型エラーなし)、`augur tests lint` (有効)、Anatomia `pr-review`。
- 未実施: 全体テスト、本番での実際の片付けの観測 (反映後に確認する)。

## 完了条件

- [x] 対象は親子の記録がある子だけで、人間起動・管制自身・常駐は閉じない。
- [x] 役目を終えた (委託 run の終端を親が受け取り済み / リポ担当 PR merged、かつ 30 分無会話) か、反応しない (60 分無会話かつ変化なし 2 回以上) ときだけ閉じる。
- [x] 待ち・審査中 PR・testing claim・未保存の変更・照会できない事実があれば閉じない。
- [x] 案内を 1 回 → 10 分後も同じなら既存の終了経路で閉じる。結果不明は再送しない。親と管制チャンネルへ知らせる。
- [x] 設定 OFF で止まり、管制が OFF なら動かない。
