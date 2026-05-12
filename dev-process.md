# Dev process marker

このファイルがあると AI agent が `npm run dev` / `npm run dev:backend` を background 起動可能。

- backend: `tsx watch src/server.ts` (port 17330 loopback)
- web: `cd web && npm run dev` (Vite)

Concordia は loopback 17330 のみで動く。 hook から /v1/sessions, /v1/chat 等を叩くため
session 監視 / chitchat / report 機能を使うときは backend を立ち上げておく。

## Concordia managed processes (v0.2)

下のフェンスがあると、 Concordia の SessionStart で自動起動 → ログ stream を WS / SSE
に流す対象になる. Concordia 本体だけは「自分自身を spawn する」 構図になるので
auto_start を **off** にしてある (起動経路は従来どおり手動 `npm run dev`).
他リポからこの仕組みを使う時は `auto_start` を省略 (= true) で OK.

```concordia.processes
{
  "processes": [
    {
      "name": "concordia-backend",
      "command": "npm run dev:backend",
      "auto_start": false
    },
    {
      "name": "concordia-web",
      "command": "npm run dev",
      "cwd": "web",
      "auto_start": false
    }
  ]
}
```

詳細: `spec/service-schema.md` §12.
