---
type: task
title: "Federation Phase 3: department routing and egress proxy"
status: in_progress
---

# Federation Phase 3

1. Add the v1 ingress and egress wire frames, then resolve a guild to exactly one active site.
2. Inject the ingress and Discord-send ports at bootstrap so federation never imports Discord.
3. Reject out-of-department egress requests, return results to the requesting site, and audit department changes.
4. Cover routing, authorization, result delivery, and timeout behavior with Vitest.
