import { OverviewService } from '@/services/contracts/OverviewService';
import { OverviewMetrics } from '@/types/overview';
import { mockStore } from './mockStore';

export class MockOverviewService implements OverviewService {
  private delay = 150;

  private async sleep() {
    return new Promise((r) => setTimeout(r, this.delay));
  }

  async getOverviewMetrics(): Promise<OverviewMetrics> {
    await this.sleep();
    const state = mockStore.getState();

    const totalCustomers = state.customers.length;
    const activeCustomers = state.customers.filter((c) => c.tenant_status === 'ACTIVE').length;
    const suspendedCustomers = state.customers.filter((c) => c.tenant_status === 'SUSPENDED').length;
    const deactivatedCustomers = state.customers.filter((c) => c.tenant_status === 'DEACTIVATED').length;

    const activeSubscriptions = state.subscriptions.filter(
      (s) => s.status === 'ACTIVE' || s.status === 'MANUALLY_GRANTED' || s.status === 'EXPIRING_SOON'
    ).length;
    const expiringSubscriptions = state.subscriptions.filter((s) => s.status === 'EXPIRING_SOON').length;

    const successfulPayments = state.payments.filter((p) => p.status === 'SUCCESS');
    const totalPaymentVolumeTZS = successfulPayments.reduce((sum, p) => sum + p.amount, 0);
    const pendingPaymentsCount = state.payments.filter((p) => p.status === 'PENDING').length;

    const connectedWhatsAppAccounts = state.connections.filter((c) => c.status === 'CONNECTED').length;
    const disconnectedWhatsAppAccounts = state.connections.filter((c) => c.status !== 'CONNECTED').length;

    const recentActivity = state.auditLogs.slice(0, 6);

    return {
      totalCustomers,
      activeCustomers,
      suspendedCustomers,
      deactivatedCustomers,
      activeSubscriptions,
      expiringSubscriptions,
      totalPaymentVolumeTZS,
      successfulPaymentsCount: successfulPayments.length,
      pendingPaymentsCount,
      connectedWhatsAppAccounts,
      disconnectedWhatsAppAccounts,
      recentActivity,
    };
  }
}
