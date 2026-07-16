# Session forum spawn has no launch template tags

- Date: 2026-07-16
- Status: fixed in working tree
- Area: Discord Session forum / delegation spawn
- Severity: high — users cannot start a session from a forum post

## Summary

This is a forum-spawn usability regression. Creating a post in the Discord Session forum stops with a request for a launch-template tag, while the same reply says that no launch templates are available.

## Evidence

User-visible reply:

```text
起動テンプレのタグが必要です。タグを付けて新しい投稿を作成してください。
利用可能: （現在利用可能なテンプレなし）
```

`src/discord/forum-spawn.ts` only accepts active delegation templates with `forum_tag=1`. `src/delegation/seed.ts` currently seeds no such template, so a fresh or normally reseeded database has no usable forum-spawn tag. Discord tag synchronization is also only exposed through the Web UI manual action.

## Regression Context

Spawn-by-post was introduced with a mandatory delegation-template tag, but the rollout did not include a default forum-ready template or an automatic boot-time tag reconciliation. The empty configuration therefore produces a dead end instead of a usable default.

## Cause

No seeded delegation template enables `forum_tag`. Existing general-purpose templates also require arguments without defaults, so they cannot safely be enabled for forum invocation as-is. The Session forum provisioning only creates fixed work/state tags and does not reconcile delegation-template tags during bot startup.

## Fix Requirements

- Seed at least one active, argument-free, forum-ready launch template; provide both Claude and Codex defaults.
- Reconcile missing template tags when the Discord layout is ensured, while keeping the explicit Web UI sync for rename/removal cleanup.
- Put the complete spawn-by-post flow in the Session forum topic/details.
- Preserve the one-template-tag requirement and duplicate-run guard.

## Verification

- Seed tests assert forum-ready templates exist and require no invocation arguments.
- Seed tests assert an existing custom forum template remains authoritative and the defaults stay disabled.
- Discord layout tests assert template tags are provisioned automatically.
- Discord layout tests assert the Session forum topic explains tag selection, project/title/body input, spawn, and subsequent thread binding.
- Existing forum-spawn tests continue to pass.
- Full regression suite: 224 files / 1603 tests passed.
- TypeScript and dependency-boundary lint passed.
- Production WebUI build passed.

## Follow-up

After deployment, restart the Discord relay or Cc so layout reconciliation runs, then confirm the Session forum exposes the default launch tags and updated details.
