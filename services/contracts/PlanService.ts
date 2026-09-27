import { Plan, UpdatePlanPriceInput, SetPlanStatusInput } from '@/types/plan';
import { MutationResult } from '@/types/api';

export interface PlanService {
  listPlans(): Promise<Plan[]>;
  getPlan(id: string): Promise<Plan | null>;
  updatePlanPrice(id: string, input: UpdatePlanPriceInput): Promise<MutationResult<Plan>>;
  setPlanStatus(id: string, input: SetPlanStatusInput): Promise<MutationResult<Plan>>;
  deletePlan(id: string): Promise<MutationResult<{ id: string }>>;
}
