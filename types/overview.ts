import { PlatformAuditLog } from './auditLog';

export interface OverviewMetrics {
  totalCustomers: number;
  activeCustomers: number;
  suspendedCustomers: number;
  deactivatedCustomers: number;
  activeSubscriptions: number;
  expiringSubscriptions: number;
  totalPaymentVolumeTZS: number;
  successfulPaymentsCount: number;
  pendingPaymentsCount: number;
  connectedWhatsAppAccounts: number;
  disconnectedWhatsAppAccounts: number;
  recentActivity: PlatformAuditLog[];
}
