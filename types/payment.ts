export type PaymentStatus = 'SUCCESS' | 'PENDING' | 'FAILED';

export interface Payment {
  id: string;
  transaction_reference: string; // e.g. WS-B4F1A93C
  tenant_id: string;
  tenant_name: string;
  customer_email: string;
  customer_phone: string;
  plan_id: string;
  plan_name: string;
  amount: number; // Historical amount in TZS
  currency: 'TZS';
  status: PaymentStatus;
  created_at: string;
  provider_reference?: string;
  failure_reason?: string;
}

export interface PaymentFilter {
  search?: string;
  status?: PaymentStatus | 'ALL';
  page?: number;
  limit?: number;
}
