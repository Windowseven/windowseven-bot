import { AuditLogService } from '@/services/contracts/AuditLogService';
import { PlatformAuditLog, AuditLogFilter } from '@/types/auditLog';
import { PaginatedResult } from '@/types/api';
import { mockStore } from './mockStore';

export class MockAuditLogService implements AuditLogService {
  private delay = 150;

  private async sleep() {
    return new Promise((r) => setTimeout(r, this.delay));
  }

  async listAuditLogs(filter?: AuditLogFilter): Promise<PaginatedResult<PlatformAuditLog>> {
    await this.sleep();
    const state = mockStore.getState();
    let list = [...state.auditLogs];

    if (filter?.action && filter.action !== 'ALL') {
      list = list.filter((a) => a.action === filter.action);
    }

    if (filter?.search) {
      const q = filter.search.toLowerCase().trim();
      list = list.filter(
        (a) =>
          a.action.toLowerCase().includes(q) ||
          a.actor_name.toLowerCase().includes(q) ||
          a.reason.toLowerCase().includes(q) ||
          a.resource_id.toLowerCase().includes(q) ||
          a.resource_type.toLowerCase().includes(q)
      );
    }

    // Newest first
    list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const page = filter?.page || 1;
    const limit = filter?.limit || 15;
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

  async getAuditLog(id: string): Promise<PlatformAuditLog | null> {
    await this.sleep();
    const state = mockStore.getState();
    return state.auditLogs.find((a) => a.id === id) || null;
  }
}
