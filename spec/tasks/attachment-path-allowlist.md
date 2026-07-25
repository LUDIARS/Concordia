# attachment_paths allowlist

## Goal

Restrict Discord attachment paths to configured workspace roots, the system temporary directory, and explicitly configured extra roots. Reject secret-like filenames and re-check paths at Discord egress.

## Tasks

- [x] Add a shared realpath-based attachment guard with UNC, containment, symlink, and denylist checks.
- [x] Validate attachments before chat insertion and return a non-sensitive 400 response.
- [x] Re-check attachments at Discord egress, supporting enforce and audit modes.
- [x] Add regression tests and run the requested verification commands.
