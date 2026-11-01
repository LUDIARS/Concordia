# Actio への書き込みに指示者を付ける (SPEC-ACTIO-ACTING-FOR)

依頼: neco「Cc の指示の主体を見分けたい」→ パターン 2「操作ログだけ」(2026-11-01)。
Actio 側の契約: Actio `spec/feature/cc-acting-for.md` (AT-CC-ACTING-FOR)。

## 内容

- Concordia は Actio にローカル持ち主 (`actio-local`, loopback) として書き込むため、Actio からは指示した人が分からない。
- セッション起点の開発ツール操作 (`DeveloperToolsService.execute`) を `withActingFor` で囲み、
  直近の人間 inject の入力者 (`lastHumanRequester`) を渡す。
- `ActioTransport` は loopback binding の書き込み (GET 以外) だけに
  `x-actio-acting-for: <discord|slack>:<userId>` を付ける。本人確認 (`/api/auth/me`)・チーム確認・bearer binding には付けない。
- userId が `[A-Za-z0-9_-]{1,64}` に合わなければ付けない。
- Actio はこの値を操作ログ (ファイル) にだけ残し、DB には保存しない。

## 範囲外 (後続)

- セッション終了・PR 連動など、開発ツール以外の経路からの書き込みへの付与
- パターン 3: Discord 利用者と Cernere 利用者の対応付け

## 実装

- `src/taskflow/actio-acting-for.ts`
- `src/taskflow/actio-transport.ts`
- `src/developer-tools/service.ts` / `src/bootstrap/core.ts` (配線)
