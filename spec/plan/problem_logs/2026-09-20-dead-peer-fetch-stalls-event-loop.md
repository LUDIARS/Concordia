# 死んだ peer への fetch が event loop を止める (ゾンビ連鎖)

- Date: 2026-09-20
- Status: fixed — `fetchFromLictor` に既定タイムアウトを入れた。 OS 側の keepalive は未対応 (下記「残件」)
- Area: Lictor proxy / loopback HTTP / プロセス寿命
- Severity: High — Cc が全面無応答になり、 harness gate 経由で全セッションの Bash/Edit/Write が止まる

## Summary

Cc (pid 25880) が port 11111 を listen したまま `/health` に一切応答しなくなった。 Ex backend と
Memoria も同じ時間帯に沈黙した。

**CPU は完全にゼロだった。** これが前例との決定的な違いで、 原因の切り分けを決めた。

- CPU delta: 5 秒間で **0.000 秒** (1 命令も実行していない)
- スレッド 14 本すべて `Wait`。 メイン JS スレッドは `Wait, Executive` (カーネルオブジェクト待ち)
- 子プロセス 0 本 (= `claude -p` 同期待ちではない)

無限ループでも CPU 過負荷でもなく、 **カーネルの待機で寝たきり**だった。 待っていた相手は:

| peer | 接続数 | 状態 |
|---|---|---|
| node 35972 (Lictor claude session) | 21 本 | `HasExited=True` (ゾンビ) |
| node 38492 (Lictor claude session) | 10 本 | `HasExited=True` (ゾンビ) |
| node 46064 (Excubitor backend) | 1 本 | `HasExited=True` (ゾンビ) |

**32 本すべてが `Established` のまま。** 相手は 3 本とも既に死んでいるのに TCP 的には接続中に見えていた。

ゾンビプロセスはカーネル側のソケットが閉じられていない。 プロセスは終了済みだが親が reap して
いないためハンドルが解放されず、 FIN が送られない。 Cc から見ると相手は生きているので read は
永久に返らず、 タイムアウトが無い経路は無限待ちになる。 メインスレッドがこの待ちに入ると
event loop は次の tick に進めない。 listen は継続する (カーネルが accept キューに積むだけ) ので、
外からは「ポートは開いているのに誰も応答しない」に見える。

## 時系列

```
12:22:22  エフェメラルポート枯渇 (System イベントログ, Tcpip warning)
            ↓ 新規接続が作れず、既存接続の後始末も失敗
12:23:25  Memoria 沈黙 → ゾンビ化 (port 1883/5180 保持)
12:23:57  Excubitor backend 沈黙 → ゾンビ化 (port 17332 保持)
            ↓ supervisor が子を reap できなくなる
12:24:57  Concordia が死んだ相手への待ちに入って停止
```

引き金はポート枯渇、 停止を継続させたのはゾンビの未クローズソケット。 ポール使用は事後に
551/16384 へ戻っていたが、 **ゾンビが残っている限り Cc は自力復帰できなかった**。

裏付け: ゾンビ 4 本が reap された瞬間、 Cc は再起動せずに `/health` 200 (2 ms) へ復帰した。
「死んだ peer への接続待ち」が停止の唯一の原因だったことが確定した。

## 前例との違い (重要)

`2026-09-03-test-forum-reconcile-event-loop-stall.md` に同じ job (test-forum reconcile) の障害が
記録されており、 Phase 1/2 で解決済み (stall 36% → 0.2%)。 **その対策は今回には効かない。**

| | 2026-09-03 | 2026-09-20 (本件) |
|---|---|---|
| CPU | 130-150% スパイク | **0.000 秒 / 5 秒** |
| 原因 | メインスレッドの JSON parse | **死んだソケット待ち** |
| 対策 | fan-in cache + 間隔 300 秒 | タイムアウト付与 |

前回の対策は現に効いており、 reconcile 自体は 8 ms で終わっている。 同じ job が別経路で刺さった。
**「event loop が止まった = 前回と同じ」と決めつけると外す。 まず CPU を測ること。**

## 誤った仮説 (実測で否定)

調査の途中で「node-pty が Job Object を使っていないので、 親が死ぬと孫が孤児化する」という
仮説を立てたが、 **実測で否定された**。

Lictor と同じ 3 段構成 (node-pty → cmd.exe → node) を作って親を `Stop-Process -Force` で
強制終了したところ、 **子孫はすべて道連れで死んだ**。 libuv は `detached` なしの子を
`KILL_ON_JOB_CLOSE` の Job に入れるため (Excubitor `breakaway-launcher.ts` の 2026-09-19 実測、
design.md §17.6 と同じ機構)、 node-pty 経由でも道連れは効いている。

したがって Lictor 側の spawn 変更は不要。 ゾンビは道連れの失敗ではなく、 **ポート枯渇で終了
処理自体が詰まった**ことによる (親も子も同時に被害を受けた)。

## Fix

`src/control/lictor-proxy.ts` の `fetchFromLictor` に既定タイムアウトを入れた。

```ts
signal: init?.signal ?? AbortSignal.timeout(LICTOR_FETCH_TIMEOUT_MS)  // 10 秒
```

この 1 箇所で、 呼び出し側 7 経路すべてが救われる (全経路が `signal` を渡していなかった):

| 経路 | 送信先 |
|---|---|
| `api/sessions/qa.ts` | `POST /v1/internal/permission-response` |
| `api/sessions/title-goal.ts` | `POST /v1/rename` |
| `api/sessions/skills.ts` | `POST /v1/skill` |
| `api/sessions/shared.ts` (`proxyGet`) | `GET /v1/fs/read`, `/v1/fs/list`, `/v1/fs/grep` |
| `api/sessions/end.ts` | `POST /v1/internal/force-exit` |
| `control/repin-session.ts` | `POST /v1/repin` |
| `model-review/runtime-switch.ts` | `POST /v1/runtime/model-effort` |

`try/catch` は全箇所にあったが、 **catch は例外が返ってきた後しか効かない**。 タイムアウトが
無ければ catch に到達せず、 undici の `headersTimeout` (300 秒) まで待つ。 loopback の sidecar は
生きていればミリ秒で返るので、 長く取る意味はなく、 むしろ死んだ相手を掴み続ける方が害になる。

`fs/grep` だけ ripgrep が大きな木を走り得るので `LICTOR_SLOW_FETCH_TIMEOUT_MS` (30 秒) を明示的に
渡す。 `proxyGet` に任意の `timeoutMs` を足した。

テストは `src/control/lictor-proxy.test.ts`。 vitest が `isolate: false` で registry を共有するため
`vi.mock` は使わず `globalThis.fetch` を差し替える ([[feedback-vitest-shared-registry-breaks-mock]])。

## 残件

1. **OS の TCP keepalive が未設定 = 2 時間。** `HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters`
   の `KeepAliveTime` が未設定で OS 既定 (7,200,000 ms)。 死んだ peer の検出に 2 時間かかる。
   アプリ側のタイムアウトで実害は塞いだが、 OS 側も 60 秒程度へ縮めると多層防御になる。
   レジストリ変更 + 再起動が要るため neco 判断。
2. **エフェメラルポートの余裕が薄い。** 動的範囲 49152-65535 (16384 個) のうち約 700 個が
   Hyper-V/WSL 等に予約済み (`netsh int ipv4 show excludedportrange protocol=tcp`)。
   12:22 の枯渇スパイクが何由来かは未特定 (claude セッション 19 本が同時起動していた)。
3. **タイムアウトが無い fetch は Lictor 経路以外にも残っている。** `deploy/service-deployed-runtime.ts`
   (Discord/Slack webhook = 外部ネットワーク先で最も長く詰まり得る)、 `bootstrap/core.ts:2161`、
   `platform/reaction-workflow.ts`、 `mcp/delegation-server.ts`。 本 PR の範囲外。
4. **`server.requestTimeout` / `headersTimeout` / `keepAliveTimeout` が未設定** (`bootstrap/core.ts`)。
   受信側は Node 既定のままで明示制御がゼロ。
5. **`chat-worker.ts` の発信 WebSocket に heartbeat が無い。** backend が無言で消えると close も
   来ず再接続しない (サーバ側 ping があるので backend 生存時は救われる)。
6. **`.env.example` に旧値が残っている。** `CONCORDIA_DISCORD_TEST_FORUM_RECONCILE_SEC=30` は
   2026-09-03 に既定 300 へ変更済みだが example が 30 のまま。 コピーすると前例が再現する。

## 教訓

- **event loop 停止を見たら、 まず CPU を測る。** 0 なら待ち (I/O・ソケット・ロック)、
  高負荷ならメインスレッドの同期処理。 ここを測らずに前例へ飛びつくと外す。
- **`try/catch` はタイムアウトの代わりにならない。** 例外が返ってこない待ちには効かない。
- **プロセス境界を越える fetch は、 ヘルパの既定でタイムアウトを持たせる。** 呼び出し側 7 箇所が
  全部忘れていた以上、 「呼ぶ側が付ける」規律は機能しない。
