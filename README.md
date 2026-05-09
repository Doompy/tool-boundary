# ToolBoundary

ToolBoundary is a self-hosted control plane for AI agent tool calls.

Instead of wiring policy, approval, audit, redaction, and idempotency into every MCP server or tool wrapper, route tool calls through one boundary.

## MVP Scope

- Config-based tool registry.
- Static bearer-token auth.
- HTTP POST upstream tools.
- Deterministic policy checks.
- Minimal JSON Schema subset validation for input schemas: `type`, `required`, and `properties`.
- Local approval queue.
- JSONL audit sink.
- Audit redaction, hashing, and structural summaries.
- Idempotency keys for mutating calls.
- CLI doctor and local demo.

## Non-Goals

- ToolBoundary is not an agent framework.
- ToolBoundary is not a prompt manager.
- ToolBoundary is not a vector memory system.
- ToolBoundary is not a hosted-only dashboard.
- ToolBoundary is not an OAuth authorization server.

## Quickstart

```bash
npm install
npm run build
npm test
```

Create a config:

```bash
npm run build --workspace @tool-boundary/cli
node packages/cli/dist/index.js init
```

Run a gateway:

```bash
$env:TOOL_BOUNDARY_AGENT_TOKEN="agent-token"
$env:TOOL_BOUNDARY_OPERATOR_TOKEN="operator-token"
node packages/cli/dist/index.js serve --config ./tool-boundary.config.yaml
```

## Architecture

- `packages/core` contains domain types, policy, redaction, approvals, audit helpers, and local file stores.
- `packages/config` loads YAML/JSON config and produces doctor diagnostics.
- `apps/gateway` exposes the Fastify HTTP API and calls upstream HTTP tools.
- `packages/cli` exposes local developer commands.

## Security Model

- Raw approval tokens are returned only once and are stored as hashes.
- Audit payload redaction runs before hashing or summary generation.
- Default policy allows only `read`, `draft`, and `dryRun`.
- Mutating calls can require approval and idempotency keys.
- Idempotency keys are scoped per authenticated principal; another principal using the same key gets an independent execution.
- Agent and operator tokens should use separate scopes: agents call tools and request approvals, while operators approve/reject and read audit.
- Output summaries are structural and do not serialize full objects by default.
- Local JSON file stores are intended for MVP/local development. Production storage should inject custom store implementations through the gateway store interfaces.

## Local Demo

See `examples/basic-http-tool` for a local upstream server and sample config.

## License

Apache-2.0.
