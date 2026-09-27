import { PaymentService } from '@/services/contracts/PaymentService';
import { Payment, PaymentFilter } from '@/types/payment';
import { PaginatedResult } from '@/types/api';
import { mockStore } from './mockStore';

export class MockPaymentService implements PaymentService {
  private delay = 150;

  private async sleep() {
    return new Promise((r) => setTimeout(r, this.delay));
  }

  async listPayments(filter?: PaymentFilter): Promise<PaginatedResult<Payment>> {
    await this.sleep();
    const state = mockStore.getState();
    let list = [...state.payments];

    if (filter?.status && filter.status !== 'ALL') {
      list = list.filter((p) => p.status === filter.status);
    }

    if (filter?.search) {
      const q = filter.search.toLowerCase().trim();
      list = list.filter(
        (p) =>
          p.transaction_reference.toLowerCase().includes(q) ||
          p.tenant_name.toLowerCase().includes(q) ||
          p.customer_email.toLowerCase().includes(q) ||
          p.customer_phone.includes(q) ||
          p.plan_name.toLowerCase().includes(q) ||
          (p.provider_reference && p.provider_reference.toLowerCase().includes(q))
      );
    }

    // Sort by created_at descending
    list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

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

  async getPayment(id: string): Promise<Payment | null> {
    await this.sleep();
    const state = mockStore.getState();
    return state.payments.find((p) => p.id === id || p.transaction_reference === id) || null;
  }
}
