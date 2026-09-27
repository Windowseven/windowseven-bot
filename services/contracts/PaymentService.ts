import { Payment, PaymentFilter } from '@/types/payment';
import { PaginatedResult } from '@/types/api';

export interface PaymentService {
  listPayments(filter?: PaymentFilter): Promise<PaginatedResult<Payment>>;
  getPayment(id: string): Promise<Payment | null>;
}
