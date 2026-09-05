# 委託先 Claude セッションが ask マーカーでなく AskUserQuestion を使った

- Date: 2026-09-05
- Status: unresolved (問題ログのみ、修正は未着手)
- Area: Concordia delegation (persona-context / implementation-inject) × Lictor ask-marker 注入
- Severity: 中。リレー越し (Discord) に回答できない対話 picker で委託セッションが止まる。今回は約 36 秒でターミナル側から回答されたため実害は小さいが、無人運用では delegation が黙って停滞する

## Summary

「AskUserQuestion ではなく、Cc が中継できる JSON 形式の ask マーカーを使うこと」という指示に反した事象の記録。

指示を受けた親セッション自身は AskUserQuestion を呼ばず、ask マーカーを 3 回使っていた。

AskUserQuestion を呼んだのは、親が Concordia delegation で起動した **子セッション** である。

- 実装タスクを渡した delegation run
- 対象リポジトリの専用 worktree で起動した子セッション
- 2026-09-05 16:13:54 JST に `AskUserQuestion` を 1 回呼び、16:14:30 JST に回答が返って続行した

## Evidence

- 子セッションのローカル transcript
  - tool_use `AskUserQuestion` @ 2026-09-05T07:13:54Z。別リポの設計書を確認できない状態で、契約設定の解釈を確認する 2 択を提示した
  - tool_result @ 2026-09-05T07:14:30Z。設計書を先に確認する旨の回答を受けて続行した
- 子セッションの生成済み session assets には、親と同内容の `ask-marker-system-prompt.txt` が存在した。つまり `--append-system-prompt-file` による ask マーカー規則は子にも渡っていた
- `lictor-ask-marker` は skill としてではなく system prompt 追記で渡す設計であり、子セッションもその設計どおりだった
- 対象 run の delegation prompt に `AskUserQuestion` / `ask マーカー` への言及は 0 件。Concordia 側の `src/delegation/persona-context.ts` / `implementation-inject.ts` にも ask マーカー規則の注入は無い

## Regression Context

- Lictor SPEC-ASK-MARKER-ACTIVATION: ask マーカーの検出は注入の有無と独立。注入は system prompt 追記 1 本に依存している
- 親セッション (同じ注入経路) は規則に従っている。差は「Claude Code 本体のシステムプロンプトが『判断が要るときは AskUserQuestion を使え』と指示し、ツール自体が使える状態で残っている」点に対する、追記 1 本の指示の弱さ。親子で異なるモデルを使っており、親は追記に従った一方、子は挙動として本体側の指示に従った
- 同種の事故は memory `feedback-delegation-pitfalls` に「委託が picker で止まる」系として断片的に記録されているが、AskUserQuestion 起因として明示した問題ログは無い

## Cause

主因 (確度 高): **AskUserQuestion ツールが子セッションで無効化されておらず、ask マーカー規則は system prompt の追記 (soft) だけ**。Claude Code 既定プロンプトの「ブロックされたら AskUserQuestion」と競合し、子のモデルが既定側を選んだ。

誘因 (確度 中): 子は cwd 外の別リポにある設計書を「この worktree からは参照できない」と判断した。この run では cwd 外の Read に追加許可が必要だったため、読まずに質問へ進んだ。親の委託文は設計書のローカルパスを示しただけで、本文の同梱も `--add-dir` 相当の許可も無かった。

## Fix Requirements

1. **Lictor**: Claude provider で Cc spawn (enrollment あり) のとき `--disallowedTools AskUserQuestion` を付け、ツールを物理的に使えなくする。追記プロンプトの文言も「使わないでください」から「使えません。ask マーカーだけが回答経路です」へ強める
2. **Lictor (保険)**: ツール無効化が適用されない経路で transcript 監視が `tool_use AskUserQuestion` を検出したら、その questions を ask マーカー相当の質問カードへ変換してリレーに流す (質問が消える事故の可視化と同じ `[ask-marker]` ログ)
3. **Concordia**: 子への共通指示に「質問は ask マーカー、AskUserQuestion 禁止」を追加し、`persona-context.ts` など各経路から同じ文言を参照できるよう集約する
4. **Concordia (誘因側)**: 委託文が cwd 外のファイルを正本として参照する場合、本文を prompt に同梱するか、spawn 時に `--add-dir` で参照先リポを許可する。少なくとも委託テンプレの説明に「別リポの設計書はパスだけ渡しても読めない」を明記する

## Verification

- Lictor: Cc spawn の Claude セッションで `AskUserQuestion` を呼ぶよう誘導するテスト入力を与え、ツールが使えず ask マーカーで質問が出ることを wrap のテスト (`src/*.test.ts`) で確認する。既存の ask-marker 検出テストに「AskUserQuestion tool_use → 質問カード変換」のケースを足す
- Concordia: persona-context のスナップショットテストに ask マーカー規則の 1 行が含まれることを追加
- 本ログは問題記録のみのため、テストは実行していない

## Follow-up

- 同日に別セッションで観測された AskUserQuestion 使用も同じ原因かを確認する
- memory `feedback-delegation-pitfalls` に「子セッションの AskUserQuestion は Lictor の relay で答えられない。cwd 外の正本は同梱する」を追補する
