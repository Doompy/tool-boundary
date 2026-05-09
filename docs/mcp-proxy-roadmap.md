# MCP Proxy Roadmap

ToolBoundary v0.2 exposes configured ToolBoundary tools as an MCP stdio server. v0.2.1 adds explicit config-based stdio MCP upstream targets. Both modes reuse the same policy, approval, audit, redaction, output validation, and idempotency path as the HTTP gateway.

Automatic upstream tool mirroring remains a later transport because wrapping third-party MCP servers adds authorization, process management, and origin-validation complexity.

## Current Transport Shape

- `tool-boundary mcp:serve --config <path> --token-env <env>` starts an MCP stdio server.
- `tool-boundary mcp:proxy --config <path> --token-env <env>` starts the same MCP server but requires at least one configured MCP upstream target.
- Each configured ToolBoundary tool is listed as an MCP tool.
- Tool calls pass through ToolBoundary's existing service layer instead of bypassing the action boundary.
- `target.type: mcp` forwards the redacted and governed call to a named stdio upstream tool.

## Future Transport Shape

- Automatic stdio MCP tool mirroring: ToolBoundary would discover upstream tools and generate a policy overlay instead of requiring each proxied tool to be declared.
- Streamable HTTP MCP proxy: ToolBoundary would sit between clients and MCP HTTP servers, enforcing authorization, origin validation, audit, and redaction on each tool call.

## Authorization Expectations

- ToolBoundary should not replace application authorization.
- Gateway auth decides whether an agent may call a registered tool.
- Downstream services still enforce business permissions.
- MCP authorization should follow the current MCP authorization model when proxying Streamable HTTP.

## Origin Validation

- Browser-accessible MCP transports need strict Origin validation.
- ToolBoundary should reject unexpected origins before any tool metadata or tool call is processed.
- Localhost-only development defaults should remain explicit.

## Audit Interception

- The proxy layer should audit the normalized tool call request, policy decision, approval state, upstream result, and error outcome.
- Raw approval tokens, credentials, and configured secret paths must never be persisted.
- Output summaries should remain structural by default.

## References

- [MCP transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
