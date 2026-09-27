export type SubscriptionStatus =
  | 'ACTIVE'
  | 'EXPIRING_SOON'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'MANUALLY_GRANTED';

export interface Subscription {
  id: string;
  tenant_id: string;
  tenant_name: string;
  customer_email: string;
  customer_phone: string;
  plan_id: string;
  plan_name: string;
  status: SubscriptionStatus;
  price_snapshot: number; // Historical price in TZS
  currency: 'TZS';
  starts_at: string;
  expires_at: string;
  days_remaining: number;
  source: 'ONLINE_PAYMENT' | 'MANUAL_GRANT';
  created_at: string;
}

export interface SubscriptionFilter {
  search?: string;
  status?: SubscriptionStatus | 'ALL';
  page?: number;
  limit?: number;
}

export interface GrantSubscriptionInput {
  tenant_id: string;
  plan_id: string;
  reason: string;
}

export interface ExtendSubscriptionInput {
  days: number;
  reason: string;
}

export interface CancelSubscriptionInput {
  reason: string;
}
