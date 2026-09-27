export type PlatformAuditAction =
  | 'TENANT_SUSPENDED'
  | 'TENANT_REACTIVATED'
  | 'TENANT_DEACTIVATED'
  | 'PLAN_UPDATED'
  | 'PLAN_STATUS_CHANGED'
  | 'PLAN_DELETED'
  | 'SUBSCRIPTION_GRANTED'
  | 'SUBSCRIPTION_EXTENDED'
  | 'SUBSCRIPTION_CANCELLED'
  | 'CONNECTION_DISCONNECTED';

export interface PlatformAuditLog {
  id: string;
  actor_id: string;
  actor_name: string;
  actor_role: string;
  action: PlatformAuditAction;
  resource_type: string;
  resource_id: string;
  reason: string;
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface AuditLogFilter {
  search?: string;
  action?: PlatformAuditAction | 'ALL';
  page?: number;
  limit?: number;
}
