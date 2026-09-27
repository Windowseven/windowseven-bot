import { Customer, CustomerFilter, SuspendCustomerInput, ReactivateCustomerInput, DeactivateCustomerInput } from '@/types/customer';
import { PaginatedResult, MutationResult } from '@/types/api';

export interface CustomerService {
  listCustomers(filter?: CustomerFilter): Promise<PaginatedResult<Customer>>;
  getCustomer(id: string): Promise<Customer | null>;
  suspendCustomer(id: string, input: SuspendCustomerInput): Promise<MutationResult<Customer>>;
  reactivateCustomer(id: string, input: ReactivateCustomerInput): Promise<MutationResult<Customer>>;
  deactivateCustomer(id: string, input: DeactivateCustomerInput): Promise<MutationResult<Customer>>;
}
