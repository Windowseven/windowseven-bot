import { ConnectionService } from '@/services/contracts/ConnectionService';
import { WhatsAppConnection, ConnectionFilter, ForceDisconnectInput } from '@/types/connection';
import { PaginatedResult, MutationResult } from '@/types/api';
import { mockStore } from './mockStore';

export class MockConnectionService implements ConnectionService {
  private delay = 150;

  private async sleep() {
    return new Promise((r) => setTimeout(r, this.delay));
  }

  async listConnections(filter?: ConnectionFilter): Promise<PaginatedResult<WhatsAppConnection>> {
    await this.sleep();
    const state = mockStore.getState();
    let list = [...state.connections];

    if (filter?.status && filter.status !== 'ALL') {
      list = list.filter((c) => c.status === filter.status);
    }

    if (filter?.search) {
      const q = filter.search.toLowerCase().trim();
      list = list.filter(
        (c) =>
          c.tenant_name.toLowerCase().includes(q) ||
          c.customer_phone.includes(q) ||
          (c.assigned_worker_id && c.assigned_worker_id.toLowerCase().includes(q))
      );
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

  async getConnection(id: string): Promise<WhatsAppConnection | null> {
    await this.sleep();
    const state = mockStore.getState();
    return state.connections.find((c) => c.id === id || c.tenant_id === id) || null;
  }

  async forceDisconnect(id: string, input: ForceDisconnectInput): Promise<MutationResult<WhatsAppConnection>> {
    await this.sleep();
    if (!input.reason?.trim()) {
      throw { code: 'VALIDATION_ERROR', message: 'A specific reason is required to force disconnect a WhatsApp connection.', status: 400 };
    }

    const state = mockStore.getState();
    const conn = state.connections.find((c) => c.id === id || c.tenant_id === id);
    if (!conn) {
      throw { code: 'NOT_FOUND', message: 'WhatsApp connection not found.', status: 404 };
    }

    conn.status = 'DISCONNECTED';
    conn.desired_state = 'STOPPED';
    conn.actual_state = 'SOCKET_DISCONNECTED';
    conn.assigned_worker_id = null;
    conn.updated_at = new Date().toISOString();

    // Also update customer connection state
    const customer = state.customers.find((c) => c.tenant_id === conn.tenant_id);
    if (customer) {
      customer.connection_state = 'DISCONNECTED';
      customer.updated_at = new Date().toISOString();
    }

    mockStore.appendAuditLog({
      actor_id: 'admin-current',
      actor_name: 'Current Administrator',
      actor_role: 'SUPPORT_LEAD',
      action: 'CONNECTION_DISCONNECTED',
      resource_type: 'CONNECTION',
      resource_id: conn.id,
      reason: input.reason.trim(),
      metadata: { tenant_id: conn.tenant_id, customer_phone: conn.customer_phone },
    });

    return { success: true, data: { ...conn }, message: 'WhatsApp connection forcefully halted via control plane.' };
  }
}
