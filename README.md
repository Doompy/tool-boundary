# ToolBoundary

ToolBoundary is a self-hosted action firewall for AI agents.

It sits between agents and tools to enforce approval, policy, audit, redaction, output validation, and idempotency before side effects happen.

MCP makes tools easy to connect. ToolBoundary makes them safe to run.

## MVP Scope

- Config-based tool registry.
- Static bearer-token auth.
- HTTP POST upstream tools.
- MCP stdio upstream tools through explicit config.
- Deterministic policy checks.
- JSON Schema validation for tool inputs through AJV.
- Optional output schema validation in `enforce` or `auditOnly` mode.
- Local approval queue.
- JSONL or SQLite audit sink.
- Audit redaction, hashing, and structural summaries.
- Idempotency keys for mutating calls.
- MCP stdio server mode for configured tools.
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

Docker demo:

```bash
docker compose -f examples/basic-http-tool/compose.yaml up --build
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

Expose configured tools over MCP stdio:

```bash
$env:TOOL_BOUNDARY_AGENT_TOKEN="agent-token"
node packages/cli/dist/index.js mcp:serve --config ./tool-boundary.config.yaml --token-env TOOL_BOUNDARY_AGENT_TOKEN
```

Proxy configured MCP upstream tools through the same boundary:

```bash
$env:TOOL_BOUNDARY_UPSTREAM_TOKEN="fixture-token"
npm run build --workspace tool-boundary-basic-mcp-proxy
node packages/cli/dist/index.js mcp:proxy --config ./examples/basic-mcp-proxy/tool-boundary.config.yaml --token-env TOOL_BOUNDARY_AGENT_TOKEN
```

Run doctor in CI:

```bash
node packages/cli/dist/index.js doctor --config ./tool-boundary.config.yaml --format sarif --ci
```

## Architecture

- `packages/core` contains domain types, policy, redaction, approvals, audit helpers, file stores, and SQLite stores.
- `packages/config` loads YAML/JSON config and produces doctor diagnostics.
- `apps/gateway` exposes the Fastify HTTP API, MCP stdio server, MCP upstream proxy executor, and shared tool call service.
- `packages/cli` exposes local developer commands.

## Security Model

- Raw approval tokens are returned only once and are stored as hashes.
- Audit payload redaction runs before hashing or summary generation.
- Default policy allows only `read`, `draft`, and `dryRun`.
- Mutating calls can require approval and idempotency keys.
- Idempotency keys are scoped per authenticated principal; another principal using the same key gets an independent execution.
- Idempotency replay is also bound to an execution fingerprint of the tool version, target, input schema, and policy. Bump `tool.version` when upstream semantics change intentionally.
- Agent and operator tokens should use separate scopes: agents call tools and request approvals, while operators approve/reject and read audit.
- Output validation is opt-in. `enforce` blocks invalid upstream output; `auditOnly` records a guardrail event while returning the output.
- Output summaries are structural and do not serialize full objects by default.
- Audit reads support `limit`, `after`, `toolName`, and `eventType` query parameters for local tailing and review.
- Local JSON file stores are intended for development. SQLite is the recommended local durable store; production deployments can inject custom store implementations through the gateway store interfaces.

## Local Demo

See `examples/basic-http-tool` for a local upstream server and sample config.

## License

Apache-2.0.
