import { PlanService } from '@/services/contracts/PlanService';
import { Plan, UpdatePlanPriceInput, SetPlanStatusInput } from '@/types/plan';
import { MutationResult } from '@/types/api';
import { mockStore } from './mockStore';

export class MockPlanService implements PlanService {
  private delay = 150;

  private async sleep() {
    return new Promise((r) => setTimeout(r, this.delay));
  }

  async listPlans(): Promise<Plan[]> {
    await this.sleep();
    const state = mockStore.getState();
    return [...state.plans];
  }

  async getPlan(id: string): Promise<Plan | null> {
    await this.sleep();
    const state = mockStore.getState();
    return state.plans.find((p) => p.id === id || p.code === id) || null;
  }

  async updatePlanPrice(id: string, input: UpdatePlanPriceInput): Promise<MutationResult<Plan>> {
    await this.sleep();
    if (typeof input.price !== 'number' || input.price < 0 || isNaN(input.price)) {
      throw { code: 'VALIDATION_ERROR', message: 'Plan price must be a valid non-negative number.', status: 400 };
    }

    const state = mockStore.getState();
    const plan = state.plans.find((p) => p.id === id);
    if (!plan) {
      throw { code: 'NOT_FOUND', message: 'Plan not found.', status: 404 };
    }

    const oldPrice = plan.price;
    plan.price = Math.round(input.price);
    plan.updated_at = new Date().toISOString();

    mockStore.appendAuditLog({
      actor_id: 'admin-current',
      actor_name: 'Current Administrator',
      actor_role: 'BILLING_ADMIN',
      action: 'PLAN_UPDATED',
      resource_type: 'PLAN',
      resource_id: plan.id,
      reason: `Updated plan price from ${oldPrice} TZS to ${plan.price} TZS`,
      metadata: { plan_code: plan.code, old_price: oldPrice, new_price: plan.price },
    });

    return { success: true, data: { ...plan }, message: `Plan price updated to ${plan.price.toLocaleString()} TZS.` };
  }

  async setPlanStatus(id: string, input: SetPlanStatusInput): Promise<MutationResult<Plan>> {
    await this.sleep();
    if (input.status !== 'ACTIVE' && input.status !== 'INACTIVE') {
      throw { code: 'VALIDATION_ERROR', message: 'Plan status must be ACTIVE or INACTIVE.', status: 400 };
    }

    const state = mockStore.getState();
    const plan = state.plans.find((p) => p.id === id);
    if (!plan) {
      throw { code: 'NOT_FOUND', message: 'Plan not found.', status: 404 };
    }

    const oldStatus = plan.status;
    plan.status = input.status;
    plan.updated_at = new Date().toISOString();

    mockStore.appendAuditLog({
      actor_id: 'admin-current',
      actor_name: 'Current Administrator',
      actor_role: 'BILLING_ADMIN',
      action: 'PLAN_STATUS_CHANGED',
      resource_type: 'PLAN',
      resource_id: plan.id,
      reason: `Changed plan status from ${oldStatus} to ${plan.status}`,
      metadata: { plan_code: plan.code, old_status: oldStatus, new_status: plan.status },
    });

    return { success: true, data: { ...plan }, message: `Plan status set to ${plan.status}.` };
  }

  async deletePlan(id: string): Promise<MutationResult<{ id: string }>> {
    await this.sleep();
    const state = mockStore.getState();
    const planIndex = state.plans.findIndex((p) => p.id === id);
    if (planIndex === -1) {
      throw { code: 'NOT_FOUND', message: 'Plan not found.', status: 404 };
    }

    const plan = state.plans[planIndex];
    if (plan.active_subscriptions_count > 0) {
      throw {
        code: 'PLAN_IN_USE',
        message: `Cannot delete plan "${plan.name}": ${plan.active_subscriptions_count} active subscriptions are currently referencing it. Please set the plan status to INACTIVE instead.`,
        status: 400,
      };
    }

    state.plans.splice(planIndex, 1);

    mockStore.appendAuditLog({
      actor_id: 'admin-current',
      actor_name: 'Current Administrator',
      actor_role: 'SUPER_ADMIN',
      action: 'PLAN_DELETED',
      resource_type: 'PLAN',
      resource_id: id,
      reason: `Archived/deleted unused plan ${plan.name} (${plan.code})`,
      metadata: { plan_name: plan.name, plan_code: plan.code },
    });

    return { success: true, data: { id }, message: 'Plan deleted successfully.' };
  }
}
