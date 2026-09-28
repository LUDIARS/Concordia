---
title: Command and generated script catalog
id: CC-COMMAND-CATALOG-01
status: draft
service: concordia
domain: tooling
---

# Read-only command and script catalog

UX-CC-W1/W3/W5, S1/S4/S3: developers identify a command's target, usage, effects, and verification state before choosing it. The WebUI has MCP tools, common commands, and generated scripts tabs. Search applies within the selected tab. Generated scripts are scoped to a selected registered project code; an empty registry is distinct from a read failure.

The root `command-runner.mjs list` owns common command names, usage, and descriptions. Cc's `tools/command-tools/cli.mjs script:list` owns generated script manifests and digest-matched verification results. The project code registry owns allowed repository paths. Listing executes no generated script, test, repository module, or command operation. Permission labels disclose expected effects; they grant nothing. A verified badge means current bytes match a successful test receipt, not execution authorization.

CC-COMMAND-CATALOG-01: The API resolves project codes through the current registry, checks canonical repository paths against configured workspace roots, and rejects missing or escaping paths. The command runner and Cc CLI paths are fixed trusted paths. Shell-free child processes have time, output, and concurrency limits. Malformed or incomplete output is an error, not an empty list. The client discards old responses after tab or repository changes. The page exposes no execution controls. Errors and zero results have distinct states and can be retried.

CC-INV-01/02: repo selection uses registered codes and canonical workspace paths; listing does not bypass the harness. CC-INV-04: failed and unknown reads remain visible, and verification state matches the owner's current receipt. This feature owns no persistent state. Recovery is a new read after correcting the registry, path, or source; it never repeats an effectful command.
