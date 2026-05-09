# Basic HTTP Tool Example

This example runs a local upstream HTTP tool server for ToolBoundary.

Docker:

```bash
docker compose -f examples/basic-http-tool/compose.yaml up --build
```

Manual:

```bash
npm install
$env:TOOL_BOUNDARY_AGENT_TOKEN="agent-token"
$env:TOOL_BOUNDARY_OPERATOR_TOKEN="operator-token"
npm run example:basic
```

In another terminal:

```bash
$env:TOOL_BOUNDARY_AGENT_TOKEN="agent-token"
$env:TOOL_BOUNDARY_OPERATOR_TOKEN="operator-token"
node packages/cli/dist/index.js serve --config examples/basic-http-tool/tool-boundary.config.yaml
```

Call a read tool:

```bash
curl -X POST http://127.0.0.1:3050/v1/tools/admin.searchUsers/call `
  -H "authorization: Bearer agent-token" `
  -H "content-type: application/json" `
  -d "{\"input\":{\"query\":\"ada\"}}"
```

Mutating calls require approval and an idempotency key. Idempotency replay is scoped to the caller and the tool execution fingerprint; bump `version` in the tool config when upstream behavior changes intentionally.

The example config uses SQLite storage so approvals, idempotency records, and audit events survive gateway restarts in `.tool-boundary/toolboundary.db`.
