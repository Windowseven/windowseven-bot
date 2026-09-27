export type TenantStatus = 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';

export type CustomerSubscriptionStatus = 'ACTIVE' | 'EXPIRING_SOON' | 'EXPIRED' | 'CANCELLED' | 'MANUALLY_GRANTED' | 'NONE';

export type CustomerConnectionStatus = 'CONNECTED' | 'DISCONNECTED' | 'CONNECTING' | 'ERROR' | 'STOPPED';

export interface Customer {
  id: string;
  name: string;
  email: string;
  phone_number: string;
  tenant_id: string;
  tenant_name: string;
  tenant_status: TenantStatus;
  subscription_status: CustomerSubscriptionStatus;
  current_plan_name: string | null;
  subscription_expires_at: string | null;
  days_remaining: number;
  connection_state: CustomerConnectionStatus;
  created_at: string;
  updated_at: string;
  metadata?: {
    groups_count?: number;
    messages_moderated?: number;
    suspended_at?: string;
    deactivated_at?: string;
    last_reason?: string;
  };
}

export interface CustomerFilter {
  search?: string;
  status?: TenantStatus | 'ALL';
  page?: number;
  limit?: number;
  sortBy?: 'created_at' | 'name' | 'subscription_expires_at';
  sortOrder?: 'asc' | 'desc';
}

export interface SuspendCustomerInput {
  reason: string;
}

export interface ReactivateCustomerInput {
  reason: string;
}

export interface DeactivateCustomerInput {
  reason: string;
  confirmTenantName: string;
}
