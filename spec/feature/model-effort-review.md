---
title: Genius model / effort review
status: implemented
---

# Genius model / effort review

## Scope

DiscordからのSession Spawnと、LictorがCcへ通知するtask変更を対象に、同じprovider内の
model / reasoning effortがタスクに適切かを再評価する。

## Flow

1. Spawn要求または`session.task_changed`を受ける。
2. 現在のmodel / effortとtaskをGeniusへ問い合わせる。
3. score閾値以上のカードが無い、またはGenius不在ならcache missとしてDiscordへ記録し、
   現在値を維持する。missからjudgeへフォールバックしない。
4. Genius hit時だけ、Ccの小型judgeがmodel catalogとprovider別effort候補から一組を選ぶ。
5. 現在値と異なる場合だけDiscordに「候補へ切替 / 現在設定を維持」の確認を出す。
6. Spawn前の承認は候補を明示optionへ変換してから起動する。task変更後の承認はLictorの
   provider-native endpointへ渡す。

## Runtime switch boundary

- Claude: Lictorが`/model <id>`、続いて`/effort <level>`を送る。
- Codex TUI: `/model`は選択UIであり、正確な非対話指定を保証できない。Lictorは409と
  再Spawn/手動選択案内を返し、catalog順を仮定したキー操作はしない。
- Codex App Server delegation: turnごとにmodel / effortを明示できるため、次turn設定として扱える。

## Source boundary

このキャッシュhit/miss制御に使うのはGeniusだけで、Anatomiaや一般HTTPキャッシュの結果は
model / effort切替条件に含めない。
