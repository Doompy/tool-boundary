# Basic HTTP Tool Example

This example runs a local upstream HTTP tool server for ToolBoundary.

```bash
npm install
$env:TOOL_BOUNDARY_AGENT_TOKEN="local-token"
npm run example:basic
```

In another terminal:

```bash
node packages/cli/dist/index.js serve --config examples/basic-http-tool/tool-boundary.config.yaml
```

Call a read tool:

```bash
curl -X POST http://127.0.0.1:3050/v1/tools/admin.searchUsers/call `
  -H "authorization: Bearer local-token" `
  -H "content-type: application/json" `
  -d "{\"input\":{\"query\":\"ada\"}}"
```

Mutating calls require approval and an idempotency key.
