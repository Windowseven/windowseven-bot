import { SubscriptionService } from '@/services/contracts/SubscriptionService';
import {
  Subscription,
  SubscriptionFilter,
  GrantSubscriptionInput,
  ExtendSubscriptionInput,
  CancelSubscriptionInput,
} from '@/types/subscription';
import { PaginatedResult, MutationResult } from '@/types/api';
import { mockStore } from './mockStore';

export class MockSubscriptionService implements SubscriptionService {
  private delay = 150;

  private async sleep() {
    return new Promise((r) => setTimeout(r, this.delay));
  }

  async listSubscriptions(filter?: SubscriptionFilter): Promise<PaginatedResult<Subscription>> {
    await this.sleep();
    const state = mockStore.getState();
    let list = [...state.subscriptions];

    if (filter?.status && filter.status !== 'ALL') {
      list = list.filter((s) => s.status === filter.status);
    }

    if (filter?.search) {
      const q = filter.search.toLowerCase().trim();
      list = list.filter(
        (s) =>
          s.tenant_name.toLowerCase().includes(q) ||
          s.customer_email.toLowerCase().includes(q) ||
          s.customer_phone.includes(q) ||
          s.plan_name.toLowerCase().includes(q)
      );
    }

    // Default sort by starts_at descending
    list.sort((a, b) => new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime());

    const page = filter?.page || 1;
    const limit = filter?.limit || 10;
    const start = (page - 1) * limit;
    const paginated = list.slice(start, start + limit);

    return {
      items: paginated,
      total: list.length,
      page,
      limit,
      totalPages: Math.ceil(list.length / limit) || 1,
    };
  }

  async getSubscription(id: string): Promise<Subscription | null> {
    await this.sleep();
    const state = mockStore.getState();
    return state.subscriptions.find((s) => s.id === id) || null;
  }

  async grantSubscription(input: GrantSubscriptionInput): Promise<MutationResult<Subscription>> {
    await this.sleep();
    if (!input.reason?.trim()) {
      throw { code: 'VALIDATION_ERROR', message: 'A specific reason is required to grant a subscription.', status: 400 };
    }
    if (!input.tenant_id) {
      throw { code: 'VALIDATION_ERROR', message: 'Target tenant ID is required.', status: 400 };
    }
    if (!input.plan_id) {
      throw { code: 'VALIDATION_ERROR', message: 'Plan ID is required.', status: 400 };
    }

    const state = mockStore.getState();
    const customer = state.customers.find((c) => c.tenant_id === input.tenant_id || c.id === input.tenant_id);
    if (!customer) {
      throw { code: 'NOT_FOUND', message: 'Customer/Tenant not found.', status: 404 };
    }

    const plan = state.plans.find((p) => p.id === input.plan_id);
    if (!plan) {
      throw { code: 'NOT_FOUND', message: 'Plan not found.', status: 404 };
    }

    const now = new Date();
    const expires = new Date(now.getTime() + plan.duration_days * 24 * 60 * 60 * 1000);

    const newSub: Subscription = {
      id: `sub-${Date.now()}`,
      tenant_id: customer.tenant_id,
      tenant_name: customer.tenant_name,
      customer_email: customer.email,
      customer_phone: customer.phone_number,
      plan_id: plan.id,
      plan_name: plan.name,
      status: 'MANUALLY_GRANTED',
      price_snapshot: 0,
      currency: 'TZS',
      starts_at: now.toISOString(),
      expires_at: expires.toISOString(),
      days_remaining: plan.duration_days,
      source: 'MANUAL_GRANT',
      created_at: now.toISOString(),
    };

    state.subscriptions.unshift(newSub);

    // Update customer's subscription summary
    customer.subscription_status = 'MANUALLY_GRANTED';
    customer.current_plan_name = plan.name;
    customer.subscription_expires_at = expires.toISOString();
    customer.days_remaining = plan.duration_days;
    customer.updated_at = now.toISOString();

    mockStore.appendAuditLog({
      actor_id: 'admin-current',
      actor_name: 'Current Administrator',
      actor_role: 'BILLING_ADMIN',
      action: 'SUBSCRIPTION_GRANTED',
      resource_type: 'SUBSCRIPTION',
      resource_id: newSub.id,
      reason: input.reason.trim(),
      metadata: {
        tenant_id: customer.tenant_id,
        plan_id: plan.id,
        duration_days: plan.duration_days,
      },
    });

    return { success: true, data: newSub, message: `Granted ${plan.name} to ${customer.name}.` };
  }

  async extendSubscription(id: string, input: ExtendSubscriptionInput): Promise<MutationResult<Subscription>> {
    await this.sleep();
    if (!input.reason?.trim()) {
      throw { code: 'VALIDATION_ERROR', message: 'A specific reason is required to extend a subscription.', status: 400 };
    }
    if (!input.days || input.days <= 0 || isNaN(input.days)) {
      throw { code: 'VALIDATION_ERROR', message: 'Extension days must be a positive number.', status: 400 };
    }

    const state = mockStore.getState();
    const sub = state.subscriptions.find((s) => s.id === id);
    if (!sub) {
      throw { code: 'NOT_FOUND', message: 'Subscription not found.', status: 404 };
    }

    const currentExpiry = new Date(sub.expires_at).getTime() > Date.now() ? new Date(sub.expires_at) : new Date();
    const newExpiry = new Date(currentExpiry.getTime() + input.days * 24 * 60 * 60 * 1000);

    sub.expires_at = newExpiry.toISOString();
    sub.days_remaining = Math.max(0, Math.ceil((newExpiry.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
    if (sub.status === 'EXPIRED') {
      sub.status = 'ACTIVE';
    }

    // Update customer entity
    const customer = state.customers.find((c) => c.tenant_id === sub.tenant_id);
    if (customer) {
      customer.subscription_expires_at = sub.expires_at;
      customer.days_remaining = sub.days_remaining;
      customer.subscription_status = sub.status;
      customer.updated_at = new Date().toISOString();
    }

    mockStore.appendAuditLog({
      actor_id: 'admin-current',
      actor_name: 'Current Administrator',
      actor_role: 'BILLING_ADMIN',
      action: 'SUBSCRIPTION_EXTENDED',
      resource_type: 'SUBSCRIPTION',
      resource_id: sub.id,
      reason: input.reason.trim(),
      metadata: { days_added: input.days, new_expires_at: sub.expires_at },
    });

    return {
      success: true,
      data: { ...sub },
      message: `Subscription extended by ${input.days} days (Expires ${newExpiry.toLocaleDateString()}).`,
    };
  }

  async cancelSubscription(id: string, input: CancelSubscriptionInput): Promise<MutationResult<Subscription>> {
    await this.sleep();
    if (!input.reason?.trim()) {
      throw { code: 'VALIDATION_ERROR', message: 'A specific reason is required to cancel a subscription.', status: 400 };
    }

    const state = mockStore.getState();
    const sub = state.subscriptions.find((s) => s.id === id);
    if (!sub) {
      throw { code: 'NOT_FOUND', message: 'Subscription not found.', status: 404 };
    }

    sub.status = 'CANCELLED';
    sub.days_remaining = 0;

    // Update customer entity
    const customer = state.customers.find((c) => c.tenant_id === sub.tenant_id);
    if (customer) {
      customer.subscription_status = 'CANCELLED';
      customer.days_remaining = 0;
      customer.updated_at = new Date().toISOString();
    }

    mockStore.appendAuditLog({
      actor_id: 'admin-current',
      actor_name: 'Current Administrator',
      actor_role: 'BILLING_ADMIN',
      action: 'SUBSCRIPTION_CANCELLED',
      resource_type: 'SUBSCRIPTION',
      resource_id: sub.id,
      reason: input.reason.trim(),
      metadata: { tenant_id: sub.tenant_id },
    });

    return { success: true, data: { ...sub }, message: 'Subscription cancelled and entitlement revoked.' };
  }
}
