---
type: setup
title: "Concordia federation listener and site setup"
description: "Configure the opt-in headquarters listener, issue a site token once, connect a remote site securely, and verify or revoke its federation link."
service: concordia
domain: federation
tags:
  - federation
  - websocket
  - setup
  - operations
status: implemented
related:
  - ../feature/federation-link.md
  - ../plan/multi-site-federation.md
  - config-reference.md
updated: 2026-08-01
---

# Concordia federation setup

## Scope

Federation connects a headquarters (HQ) Concordia service to registered remote sites over WebSocket. It is opt-in: no federation listener starts unless `CONCORDIA_FEDERATION_LISTEN=1` is set.

The ordinary loopback management API remains on port `11111`. The federation listener uses port **`11112`**. This repository's `excubitor.catalog.yaml` fragment only records that intent as a comment — `ServiceSchema` allows one primary port per service, so the fragment declares no service and therefore does not machine-reserve `11112`. The authoritative allocation still lives in `Excubitor/catalog/services.yaml`; keep it, the fragment comment, and the listener environment in sync, and do not replace or edit the existing catalog `concordia` entry for port `11111`.

## 1. Configure the HQ listener

Set these values in the HQ service environment or its private `.env` file. Do not commit the file.

```dotenv
CONCORDIA_FEDERATION_LISTEN=1
CONCORDIA_FEDERATION_LISTEN_HOST=127.0.0.1
CONCORDIA_FEDERATION_LISTEN_PORT=11112
```

The listener speaks plaintext WebSocket and carries site tokens on the wire, so keep the loopback bind above unless a TLS-terminating tunnel or reverse proxy already fronts it. To accept remote sites, put that TLS front end in place first, then widen the bind to the narrowest address that reaches it — the specific interface the proxy connects from, and `0.0.0.0` only when no narrower address works.

After the service owner starts the configured service, check the ordinary loopback API:

```bash
curl -s http://127.0.0.1:11111/v1/federation
node tools/federation-check.mjs
```

`listener_enabled: true` (and `Listener: enabled` in the script) confirms that the HQ accepted the listener configuration. This check does not itself start or restart a service. The script reads `http://127.0.0.1:11111` unless `CONCORDIA_URL` points at another loopback base URL.

## 2. Register a site and save its token

At the HQ, register each site once through the loopback API. `site_id` must match `[a-z0-9][a-z0-9-]{1,63}`.

```bash
curl -sS -X POST http://127.0.0.1:11111/v1/federation/sites \
  -H 'content-type: application/json' \
  -d '{"site_id":"osaka-dev","name":"Osaka development site"}'
```

The successful response includes a `token`. The plaintext token is shown **only in this registration response**; Concordia stores an encrypted value and cannot display it later. Immediately save it in the site's approved secret store (for example, the site's Infisical secret), not in Git, a ticket, or chat history.

There is no token-reissue or delete endpoint, and a revoked registration keeps its row, so re-registering the same `site_id` returns `409 site_exists` even after a revoke. If a token is lost, revoke the old registration and register the site again under a **different** `site_id` (for example `osaka-dev-2`), then update the remote site's `CONCORDIA_FEDERATION_SITE_ID` along with its token.

## 3. Configure the remote site

Set the following private environment values at the remote site:

```dotenv
CONCORDIA_FEDERATION_HQ_URL=wss://hq.example.invalid/federation/ws
CONCORDIA_FEDERATION_SITE_ID=osaka-dev
CONCORDIA_FEDERATION_SITE_TOKEN=<token-returned-at-registration>
```

`CONCORDIA_FEDERATION_HQ_URL` is the HQ listener's WebSocket endpoint. The listener only serves the path `/federation/ws` (`src/federation/hq-listener.ts`); a URL with no path (for example `wss://hq.example.invalid`) is completed to that path automatically, but any other explicit path is used as given and the handshake fails. The client accepts `ws://` only for loopback hosts. For every non-loopback host, use **`wss://`**; a plaintext remote `ws://` URL is rejected by the site client before it connects.

The site ID and token must exactly match the registration response. Keep the token in the remote site's secret store and never add it to an example file or repository configuration.

## 4. Decide what the site runs

A site receives work in two ways, and they are configured separately.

**Departments (per guild).** A department is a Discord guild. Assign the guilds a site is responsible for, and every message from those guilds is routed to that site instead of the HQ:

```bash
curl -sS -X PUT http://127.0.0.1:11111/v1/federation/sites/osaka-dev/departments \
  -H 'content-type: application/json' \
  -d '{"departments":["123456789012345678"]}'
```

Assign each guild to **one** site. When the same guild is listed under two active sites the input is ambiguous, so Concordia refuses to duplicate it: the message falls back to the HQ and an error is reported. Changing `departments` does not redistribute configuration on its own — see `spec/feature/federation-link.md`.

**Site tags (per thread).** Departments cannot express "run just this one piece of work on that PC". For that, tag the Session forum thread with the target PC. The tag names come from **Villa** (the home PC resource map, `http://127.0.0.1:17610/api/state` unless `CONCORDIA_VILLA_URL` points elsewhere), so PC names are never hard-coded in Concordia. Map the site to its Villa PC id:

```bash
curl -sS -X PUT http://127.0.0.1:11111/v1/federation/sites/osaka-dev/villa-pc \
  -H 'content-type: application/json' \
  -d '{"villa_pc_id":"pc-haster"}'
```

Concordia then offers that PC's Villa name (for example `HASTER`) as a Session forum tag. Only sites that are `active` **and** mapped to a Villa PC produce a tag — a tag that cannot route anywhere is never shown. A site tag takes priority over department routing, so a thread tagged `HASTER` runs there even when its guild belongs to another site.

Degradation is deliberate and always logged, because "I tagged it and it still ran at HQ" is otherwise impossible to explain:

| Situation | Result |
| --- | --- |
| Two or more site tags on one thread | HQ, with a warning (no side is guessed) |
| Tag maps to a revoked site | Falls back to department routing, with a warning |
| Tag is a Villa PC that no active site is mapped to | Falls back to department routing, with a warning |
| Tag name is not a Villa PC | Ignored (work-type and state tags are never read as sites) |
| Villa is unreachable | No site tags are offered; department routing continues |

Pass `{"villa_pc_id": null}` to unmap a site, which withdraws its tag.

## 5. Confirm the connection

On the HQ, inspect the federation state:

```bash
curl -s http://127.0.0.1:11111/v1/federation
node tools/federation-check.mjs
```

For the registered site, `connection: "online"` means an authenticated WebSocket is currently connected. `last_seen_at` is the most recent authenticated activity timestamp; it may remain populated after an offline connection and is useful for deciding whether a site has gone stale. `pending_events` is the number of HQ-to-site events still awaiting delivery or acknowledgement.

The WebUI offers the same overview at `/federation`, on the **拠点** tab. Check the site status, connection state, last-seen time, version, and pending events there when operators need a visual view.

## 6. Revoke a site

To invalidate a site token, call the revoke endpoint at the HQ:

```bash
curl -sS -X POST http://127.0.0.1:11111/v1/federation/sites/osaka-dev/revoke
```

Revocation is permanent for that site registration, and the `site_id` stays taken. If that site is currently connected, the HQ sends a `revoked` error and disconnects it; the site client stops reconnecting and waits for reconfiguration. To restore access, register a **new** `site_id` (§2) and update both the site ID and the token in the remote secret.

Revoking an unknown or already-revoked `site_id` returns `404 site_not_found_or_already_revoked`.

## Troubleshooting

| Error code | Meaning | Operator action |
|---|---|---|
| `auth_failed` | The site ID is unknown, revoked, or its token does not match. | Verify the site ID and secret-store token. If the token is unavailable, revoke the old registration and register a new `site_id` (§2 — the old ID cannot be reused). Repeated failures from one address are rate limited at the HQ, so wait out the 60 s window after fixing the credentials. |
| `unsupported_version` | The remote site and HQ do not share a supported federation protocol version. | Upgrade the older Concordia deployment to a compatible version, then reconnect. |
| `replaced` | A newer connection for the same site ID took over. | Check for duplicate site processes or duplicate credentials; keep only the intended connection running. |
| `revoked` | The HQ invalidated this registration. | Register a replacement site under a new `site_id` at the HQ and replace both the site ID and the token in the remote secret before reconnecting. |

## Related environment keys

Defaults and the reading code path are canonical in [`config-reference.md` §10](config-reference.md); this table only records which role sets each key.

| Key | Used by | Notes |
|---|---|---|
| `CONCORDIA_FEDERATION_LISTEN` | HQ | Set to `1` to enable the listener. |
| `CONCORDIA_FEDERATION_LISTEN_HOST` | HQ | Defaults to `127.0.0.1` when unset. |
| `CONCORDIA_FEDERATION_LISTEN_PORT` | HQ | Required whenever the listener is enabled; no implicit port exists. |
| `CONCORDIA_FEDERATION_HQ_URL` | Remote site | Use `wss://` for a non-loopback HQ. |
| `CONCORDIA_FEDERATION_SITE_ID` | Remote site | Matches the HQ registration ID. |
| `CONCORDIA_FEDERATION_SITE_TOKEN` | Remote site | Registration token; keep only in a secret store. |
| `CONCORDIA_FEDERATION_OUTBOX_MAX` | HQ | Optional maximum queued HQ-to-site events per site (oldest dropped first). |
| `CONCORDIA_FEDERATION_OUTBOX_TTL_SEC` | HQ | Optional retention period in seconds for queued HQ-to-site events. |
| `CONCORDIA_VILLA_URL` | HQ | Optional Villa base URL used to resolve site tags (§4); defaults to `http://127.0.0.1:17610`. |
