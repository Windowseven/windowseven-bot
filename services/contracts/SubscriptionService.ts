import {
  Subscription,
  SubscriptionFilter,
  GrantSubscriptionInput,
  ExtendSubscriptionInput,
  CancelSubscriptionInput,
} from '@/types/subscription';
import { PaginatedResult, MutationResult } from '@/types/api';

export interface SubscriptionService {
  listSubscriptions(filter?: SubscriptionFilter): Promise<PaginatedResult<Subscription>>;
  getSubscription(id: string): Promise<Subscription | null>;
  grantSubscription(input: GrantSubscriptionInput): Promise<MutationResult<Subscription>>;
  extendSubscription(id: string, input: ExtendSubscriptionInput): Promise<MutationResult<Subscription>>;
  cancelSubscription(id: string, input: CancelSubscriptionInput): Promise<MutationResult<Subscription>>;
}
