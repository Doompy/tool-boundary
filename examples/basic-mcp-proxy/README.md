# Basic MCP Proxy Example

This example runs a local MCP stdio server behind ToolBoundary. ToolBoundary exposes the configured tools through its HTTP gateway or MCP server while enforcing policy, approval, audit, output validation, and idempotency.

```bash
npm install
npm run build

$env:TOOL_BOUNDARY_AGENT_TOKEN="agent-token"
$env:TOOL_BOUNDARY_OPERATOR_TOKEN="operator-token"
$env:TOOL_BOUNDARY_UPSTREAM_TOKEN="fixture-token"

node ../../packages/cli/dist/index.js serve --config ./tool-boundary.config.yaml
```

Read call:

```bash
curl -s http://127.0.0.1:3051/v1/tools/admin.searchUsers/call \
  -H "authorization: Bearer agent-token" \
  -H "content-type: application/json" \
  -d "{\"input\":{\"query\":\"ada\"}}"
```

Expose the same boundary as MCP tools:

```bash
node ../../packages/cli/dist/index.js mcp:proxy --config ./tool-boundary.config.yaml --token-env TOOL_BOUNDARY_AGENT_TOKEN
```
