import { CustomerService } from './contracts/CustomerService';
import { PlanService } from './contracts/PlanService';
import { SubscriptionService } from './contracts/SubscriptionService';
import { PaymentService } from './contracts/PaymentService';
import { ConnectionService } from './contracts/ConnectionService';
import { AuditLogService } from './contracts/AuditLogService';
import { OverviewService } from './contracts/OverviewService';

import { MockCustomerService } from './mock/MockCustomerService';
import { MockPlanService } from './mock/MockPlanService';
import { MockSubscriptionService } from './mock/MockSubscriptionService';
import { MockPaymentService } from './mock/MockPaymentService';
import { MockConnectionService } from './mock/MockConnectionService';
import { MockAuditLogService } from './mock/MockAuditLogService';
import { MockOverviewService } from './mock/MockOverviewService';

// Service Registry - UI imports these singletons typed against the contracts
export const customerService: CustomerService = new MockCustomerService();
export const planService: PlanService = new MockPlanService();
export const subscriptionService: SubscriptionService = new MockSubscriptionService();
export const paymentService: PaymentService = new MockPaymentService();
export const connectionService: ConnectionService = new MockConnectionService();
export const auditLogService: AuditLogService = new MockAuditLogService();
export const overviewService: OverviewService = new MockOverviewService();
