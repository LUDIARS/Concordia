// Package metadata only. Does not run the hook or change any installed project hooks.
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('../harness-runtime/package.json', import.meta.url), JSON.stringify({ type: 'module', private: true }), 'utf8');
