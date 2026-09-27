export type PlanStatus = 'ACTIVE' | 'INACTIVE';

export interface Plan {
  id: string;
  name: string;
  code: string;
  description: string;
  price: number; // in TZS
  currency: 'TZS';
  duration_days: number;
  status: PlanStatus;
  active_subscriptions_count: number;
  created_at: string;
  updated_at: string;
}

export interface UpdatePlanPriceInput {
  price: number;
}

export interface SetPlanStatusInput {
  status: PlanStatus;
}
