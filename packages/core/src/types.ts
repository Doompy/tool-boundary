export type ToolMode = 'read' | 'draft' | 'dryRun' | 'mutate';

export type ToolRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type ToolTarget =
  | {
      readonly type: 'http';
      readonly method: 'POST';
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly timeoutMs?: number;
    }
  | {
      readonly type: 'mock';
      readonly result: unknown;
    };

export type AuditInputMode = 'full' | 'redacted' | 'hash' | 'omit';
export type AuditOutputMode = 'full' | 'redacted' | 'hash' | 'summary' | 'omit';
export type AuditErrorMode = 'full' | 'redacted' | 'summary' | 'omit';

export type AuditPayloadPolicy = {
  readonly input?: AuditInputMode;
  readonly output?: AuditOutputMode;
  readonly error?: AuditErrorMode;
  readonly redactPaths?: readonly string[];
};

export type IdempotencyPolicy = {
  readonly required?: boolean;
};

export type OutputValidationPolicy = {
  readonly enabled?: boolean;
  readonly mode?: 'enforce' | 'auditOnly';
};

export type ToolPolicyRef = string;

export type ToolApprovalPolicy = {
  readonly previewPaths?: readonly string[];
};

export type ToolDefinition = {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly mode: ToolMode;
  readonly riskLevel?: ToolRiskLevel;
  readonly approvalRequired?: boolean;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly outputValidation?: OutputValidationPolicy;
  readonly target: ToolTarget;
  readonly policy?: ToolPolicyRef;
  readonly approval?: ToolApprovalPolicy;
  readonly audit?: AuditPayloadPolicy;
  readonly idempotency?: IdempotencyPolicy;
  readonly tags?: readonly string[];
  readonly owner?: string;
  readonly deprecated?: boolean;
};

export type ToolCallRequest = {
  readonly input?: unknown;
  readonly hasInput?: boolean;
  readonly idempotencyKey?: string;
  readonly approvalToken?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export type ToolCallResult =
  | {
      readonly ok: true;
      readonly executionId: string;
      readonly toolName: string;
      readonly mode: ToolMode;
      readonly output: unknown;
      readonly approvalId?: string;
      readonly idempotencyReplay?: boolean;
    }
  | {
      readonly ok: false;
      readonly executionId?: string;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly details?: unknown;
      };
    };

export type PolicyDecision =
  | { readonly verdict: 'allow'; readonly reason?: string }
  | { readonly verdict: 'deny'; readonly reason: string }
  | { readonly verdict: 'approval_required'; readonly reason: string };

export type ToolPolicyDefinition = {
  readonly allowedModes?: readonly ToolMode[];
  readonly requireApprovalForModes?: readonly ToolMode[];
  readonly requireApprovalForRiskLevels?: readonly ToolRiskLevel[];
  readonly requireIdempotencyForModes?: readonly ToolMode[];
  readonly denyDeprecatedTools?: boolean;
};

export type ApprovalStatus = 'requested' | 'approved' | 'rejected' | 'consumed' | 'expired';

export type ApprovalRecord = {
  readonly id: string;
  readonly status: ApprovalStatus;
  readonly toolName: string;
  readonly inputHash: string;
  readonly resourceIds?: readonly string[];
  readonly dryRunHash?: string;
  readonly requestedBy: string;
  readonly approvedBy?: string;
  readonly approvalTokenHash?: string;
  readonly inputSummary?: string;
  readonly inputPreview?: unknown;
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type AuditEventType =
  | 'tool_call_started'
  | 'tool_call_allowed'
  | 'tool_call_denied'
  | 'approval_required'
  | 'tool_call_succeeded'
  | 'tool_call_failed'
  | 'approval_requested'
  | 'approval_approved'
  | 'approval_rejected'
  | 'approval_consumed'
  | 'approval_expired'
  | 'tool_output_validation_failed';

export type AuditEvent = {
  readonly id: string;
  readonly executionId?: string;
  readonly eventType: AuditEventType;
  readonly toolName: string;
  readonly mode: ToolMode;
  readonly userId?: string;
  readonly agentId?: string;
  readonly policyDecision?: PolicyDecision;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly outputSummary?: string;
  readonly error?: unknown;
  readonly approvalId?: string;
  readonly approvalTokenHash?: string;
  readonly idempotencyKey?: string;
  readonly createdAt: string;
};

export type AuditQuery = {
  readonly limit?: number;
  readonly after?: string;
  readonly toolName?: string;
  readonly eventType?: AuditEventType;
};

export type AuditQueryResult = {
  readonly events: readonly AuditEvent[];
  readonly nextCursor?: string;
};

export type StoredToolCallResult = {
  readonly executionId: string;
  readonly output: unknown;
  readonly approvalId?: string;
  readonly executionFingerprint?: string;
};
