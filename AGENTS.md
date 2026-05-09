# AGENTS.md

## Project

This repository implements ToolBoundary, a self-hosted control plane for AI agent tool calls.

## Hard Rules

- Do not add agent-generated code execution.
- Do not add LLM-based policy decisions in MVP.
- Do not log raw approval tokens.
- Do not JSON.stringify full tool output for default summaries.
- Do not require external network access in tests.
- Prefer small deterministic modules over framework magic.
- Keep gateway logic separate from core policy/audit logic.

## Commands

Run before completing any patch:

```bash
npm run build
npm run typecheck
npm test
```

For package-specific work, run the relevant workspace build and tests too.

## Style

- TypeScript strict mode.
- ESM modules.
- Zod 4 for config schemas.
- No `any` unless justified with a comment.
- Public APIs should be readonly where possible.
- Errors should use typed error classes and stable error codes.
