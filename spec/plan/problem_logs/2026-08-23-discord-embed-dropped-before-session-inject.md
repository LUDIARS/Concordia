# Discord embeds are dropped before session injection

- Date: 2026-08-23
- Status: fixed in working tree
- Area: Discord ingress / session injection
- Severity: high — users can see rich content in Discord while the LLM receives only the surrounding text

## Summary

An image visible in Discord could not be identified by the active LLM session. This is
a regression in the expected Discord-to-session rich-input route: the first implementation handled only
`Message.attachments`, while Discord link previews and rich cards are delivered through `Message.embeds`.
The session therefore received the surrounding request without any embed text, image URL, or local path.

## Evidence

- The user-visible reproduction occurred in a Discord session thread on 2026-08-23 JST.
- The injected turn contained only the surrounding request; no image path was present.
- `src/discord/ingress.ts` read `msg.content` and `msg.attachments` but never read `msg.embeds`.
- `src/discord/image-inbox.ts` required attachment-only metadata (`size` and filename/content type), so a
  Discord-proxied embed asset with unknown declared size could not use the same verified download path.
- The deployed service must be refreshed after this fix is published.

## Regression Context

Commit `6a4b9e4d` added attachment image ingestion and correctly covered image-only attachment messages, but
treated "Discord image" as synonymous with an attachment. Discord presents multiple rich-content shapes,
so the acceptance boundary was narrower than the UI behavior users rely on.

## Cause

The ingress contract omitted `Message.embeds`. Embed display text was not normalized into the prompt, and
embed image/thumbnail proxy URLs were not converted into the existing image inbox input. Empty-content
embed messages then matched the early empty-message guard and were discarded entirely.

## Fix Requirements

- Normalize embed title, description, URL, author, provider, fields, footer, timestamp, and video URL into
  bounded inject context.
- Delimit embed text as untrusted data and escape structural characters so it cannot forge the boundary.
- Route embed image and thumbnail assets through the existing verified image inbox.
- Fetch only Discord CDN/proxy URLs; never fetch an arbitrary external embed source URL.
- Allow an embed asset without a declared byte size, while retaining the streaming 20 MiB response limit.
- Preserve embed-only messages instead of treating them as empty.
- Keep bot-message loop prevention and the existing session-channel scope unchanged.

## Verification

Regression tests were added for rich embed formatting, untrusted-data boundary escaping, safe proxy selection,
unknown-size image storage, and embed-only session injection. Tests were not run in this session, per the user policy.

## Follow-up

After Revisor publishes the change, build the project main checkout and restart Concordia through Excubitor
under a testing claim. Then post an embed-only message in a session thread and confirm the injected prompt
contains both its display fields and a readable local image path.
