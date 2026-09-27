import { CustomerService } from '@/services/contracts/CustomerService';
import { Customer, CustomerFilter, SuspendCustomerInput, ReactivateCustomerInput, DeactivateCustomerInput } from '@/types/customer';
import { PaginatedResult, MutationResult } from '@/types/api';
import { mockStore } from './mockStore';

export class MockCustomerService implements CustomerService {
  private delay = 150; // Simulate network latency

  private async sleep() {
    return new Promise((r) => setTimeout(r, this.delay));
  }

  async listCustomers(filter?: CustomerFilter): Promise<PaginatedResult<Customer>> {
    await this.sleep();
    const state = mockStore.getState();
    let list = [...state.customers];

    if (filter?.status && filter.status !== 'ALL') {
      list = list.filter((c) => c.tenant_status === filter.status);
    }

    if (filter?.search) {
      const q = filter.search.toLowerCase().trim();
      list = list.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.email.toLowerCase().includes(q) ||
          c.phone_number.includes(q) ||
          c.tenant_name.toLowerCase().includes(q)
      );
    }

    // Sort
    if (filter?.sortBy) {
      list.sort((a, b) => {
        let valA = a[filter.sortBy as keyof Customer] ?? '';
        let valB = b[filter.sortBy as keyof Customer] ?? '';
        if (typeof valA === 'string') valA = valA.toLowerCase();
        if (typeof valB === 'string') valB = valB.toLowerCase();
        if (valA < valB) return filter.sortOrder === 'desc' ? 1 : -1;
        if (valA > valB) return filter.sortOrder === 'desc' ? -1 : 1;
        return 0;
      });
    }

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

  async getCustomer(id: string): Promise<Customer | null> {
    await this.sleep();
    const state = mockStore.getState();
    return state.customers.find((c) => c.id === id || c.tenant_id === id) || null;
  }

  async suspendCustomer(id: string, input: SuspendCustomerInput): Promise<MutationResult<Customer>> {
    await this.sleep();
    if (!input.reason?.trim()) {
      throw { code: 'VALIDATION_ERROR', message: 'A specific reason is required to suspend a customer.', status: 400 };
    }

    const state = mockStore.getState();
    const customer = state.customers.find((c) => c.id === id || c.tenant_id === id);
    if (!customer) {
      throw { code: 'NOT_FOUND', message: 'Customer not found.', status: 404 };
    }

    customer.tenant_status = 'SUSPENDED';
    customer.connection_state = 'DISCONNECTED';
    customer.updated_at = new Date().toISOString();
    customer.metadata = {
      ...customer.metadata,
      suspended_at: new Date().toISOString(),
      last_reason: input.reason.trim(),
    };

    mockStore.appendAuditLog({
      actor_id: 'admin-current',
      actor_name: 'Current Administrator',
      actor_role: 'SUPER_ADMIN',
      action: 'TENANT_SUSPENDED',
      resource_type: 'TENANT',
      resource_id: customer.tenant_id,
      reason: input.reason.trim(),
      metadata: { customer_name: customer.name, phone: customer.phone_number },
    });

    return { success: true, data: { ...customer }, message: 'Customer suspended successfully.' };
  }

  async reactivateCustomer(id: string, input: ReactivateCustomerInput): Promise<MutationResult<Customer>> {
    await this.sleep();
    if (!input.reason?.trim()) {
      throw { code: 'VALIDATION_ERROR', message: 'A specific reason is required to reactivate a customer.', status: 400 };
    }

    const state = mockStore.getState();
    const customer = state.customers.find((c) => c.id === id || c.tenant_id === id);
    if (!customer) {
      throw { code: 'NOT_FOUND', message: 'Customer not found.', status: 404 };
    }

    customer.tenant_status = 'ACTIVE';
    customer.updated_at = new Date().toISOString();
    customer.metadata = {
      ...customer.metadata,
      last_reason: input.reason.trim(),
    };

    mockStore.appendAuditLog({
      actor_id: 'admin-current',
      actor_name: 'Current Administrator',
      actor_role: 'SUPER_ADMIN',
      action: 'TENANT_REACTIVATED',
      resource_type: 'TENANT',
      resource_id: customer.tenant_id,
      reason: input.reason.trim(),
      metadata: { customer_name: customer.name, phone: customer.phone_number },
    });

    return { success: true, data: { ...customer }, message: 'Customer reactivated successfully.' };
  }

  async deactivateCustomer(id: string, input: DeactivateCustomerInput): Promise<MutationResult<Customer>> {
    await this.sleep();
    if (!input.reason?.trim()) {
      throw { code: 'VALIDATION_ERROR', message: 'A specific reason is required to deactivate a customer.', status: 400 };
    }

    const state = mockStore.getState();
    const customer = state.customers.find((c) => c.id === id || c.tenant_id === id);
    if (!customer) {
      throw { code: 'NOT_FOUND', message: 'Customer not found.', status: 404 };
    }

    if (input.confirmTenantName !== customer.tenant_name && input.confirmTenantName !== customer.name) {
      throw { code: 'CONFIRMATION_MISMATCH', message: 'Confirmation name did not match tenant identifier.', status: 400 };
    }

    customer.tenant_status = 'DEACTIVATED';
    customer.subscription_status = 'CANCELLED';
    customer.connection_state = 'STOPPED';
    customer.subscription_expires_at = null;
    customer.days_remaining = 0;
    customer.updated_at = new Date().toISOString();
    customer.metadata = {
      ...customer.metadata,
      deactivated_at: new Date().toISOString(),
      last_reason: input.reason.trim(),
    };

    mockStore.appendAuditLog({
      actor_id: 'admin-current',
      actor_name: 'Current Administrator',
      actor_role: 'SUPER_ADMIN',
      action: 'TENANT_DEACTIVATED',
      resource_type: 'TENANT',
      resource_id: customer.tenant_id,
      reason: input.reason.trim(),
      metadata: { customer_name: customer.name, phone: customer.phone_number },
    });

    return { success: true, data: { ...customer }, message: 'Customer account permanently deactivated.' };
  }
}
