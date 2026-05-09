import { z } from 'zod';

const toolModeSchema = z.enum(['read', 'draft', 'dryRun', 'mutate']);
const riskLevelSchema = z.enum(['low', 'medium', 'high', 'critical']);
const jsonPointerSchema = z.string().refine((value) => value === '' || value.startsWith('/'), {
  message: 'JSON Pointer must be empty string or start with /'
});

export const auditPayloadPolicySchema = z.object({
  input: z.enum(['full', 'redacted', 'hash', 'omit']).optional(),
  output: z.enum(['full', 'redacted', 'hash', 'summary', 'omit']).optional(),
  error: z.enum(['full', 'redacted', 'summary', 'omit']).optional(),
  redactPaths: z.array(z.string()).optional()
});

export const idempotencyPolicySchema = z.object({
  required: z.boolean().optional()
});

export const outputValidationPolicySchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(['enforce', 'auditOnly']).default('enforce')
});

export const toolApprovalPolicySchema = z.object({
  previewPaths: z.array(jsonPointerSchema).optional()
});

export const toolPolicySchema = z.object({
  allowedModes: z.array(toolModeSchema).optional(),
  requireApprovalForModes: z.array(toolModeSchema).optional(),
  requireApprovalForRiskLevels: z.array(riskLevelSchema).optional(),
  requireIdempotencyForModes: z.array(toolModeSchema).optional(),
  denyDeprecatedTools: z.boolean().optional()
});

const httpTargetSchema = z.object({
  type: z.literal('http'),
  method: z.literal('POST'),
  url: z.url(),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional()
});

const mockTargetSchema = z.object({
  type: z.literal('mock'),
  result: z.unknown()
});

const mcpTargetSchema = z.object({
  type: z.literal('mcp'),
  upstream: z.string().min(1),
  toolName: z.string().min(1),
  timeoutMs: z.number().int().positive().optional()
});

const storageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('file')
  }),
  z.object({
    type: z.literal('sqlite'),
    path: z.string().default('.tool-boundary/toolboundary.db')
  })
]);

const mcpUpstreamSchema = z.object({
  transport: z.string().default('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  envFrom: z.record(z.string(), z.string()).optional()
});

export const rawToolDefinitionSchema = z.object({
  version: z.string().optional(),
  description: z.string().optional(),
  mode: toolModeSchema,
  riskLevel: riskLevelSchema.optional(),
  approvalRequired: z.boolean().optional(),
  inputSchema: z.unknown().optional(),
  outputSchema: z.unknown().optional(),
  outputValidation: outputValidationPolicySchema.optional(),
  target: z.discriminatedUnion('type', [httpTargetSchema, mockTargetSchema, mcpTargetSchema]),
  policy: z.string().optional(),
  approval: toolApprovalPolicySchema.optional(),
  audit: auditPayloadPolicySchema.optional(),
  idempotency: idempotencyPolicySchema.optional(),
  tags: z.array(z.string()).optional(),
  owner: z.string().optional(),
  deprecated: z.boolean().optional()
});

export const rawConfigSchema = z.object({
  server: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().positive().max(65535).default(3050)
    })
    .default({ host: '127.0.0.1', port: 3050 }),
  auth: z.object({
    mode: z.literal('static-token'),
    tokens: z.array(
      z.object({
        name: z.string(),
        tokenEnv: z.string(),
        scopes: z.array(z.string())
      })
    )
  }),
  audit: z
    .object({
      sink: z.literal('jsonl').default('jsonl'),
      path: z.string().default('.tool-boundary/audit.jsonl'),
      defaults: auditPayloadPolicySchema.default({})
    })
    .default({ sink: 'jsonl', path: '.tool-boundary/audit.jsonl', defaults: {} }),
  storage: storageSchema.default({ type: 'file' }),
  mcp: z
    .object({
      upstreams: z.record(z.string(), mcpUpstreamSchema).default({})
    })
    .default({ upstreams: {} }),
  policies: z.record(z.string(), toolPolicySchema).default({}),
  tools: z.record(z.string(), rawToolDefinitionSchema)
});

export type RawConfig = z.infer<typeof rawConfigSchema>;
