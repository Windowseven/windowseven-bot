'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { DataTable, Column } from '@/components/common/DataTable';
import { Badge } from '@/components/common/Badge';
import { Modal } from '@/components/common/Modal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { useToast } from '@/components/common/Toast';
import { subscriptionService, planService, customerService } from '@/services';
import { Subscription, SubscriptionStatus } from '@/types/subscription';
import { Plan } from '@/types/plan';
import { Customer } from '@/types/customer';
import {
  CreditCard,
  Search,
  PlusCircle,
  Clock,
  XCircle,
  Calendar,
  Sparkles,
  Loader2,
  AlertTriangle,
} from 'lucide-react';

export default function SubscriptionsPage() {
  const toast = useToast();
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<SubscriptionStatus | 'ALL'>('ALL');
  const [refreshing, setRefreshing] = useState(false);

  // Available plans & customers for Grant Modal
  const [plans, setPlans] = useState<Plan[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);

  // Grant Modal State
  const [grantModalOpen, setGrantModalOpen] = useState(false);
  const [grantTenantId, setGrantTenantId] = useState('');
  const [grantPlanId, setGrantPlanId] = useState('');
  const [grantReason, setGrantReason] = useState('');
  const [grantSubmitting, setGrantSubmitting] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);

  // Extend Modal State
  const [extendModalSub, setExtendModalSub] = useState<Subscription | null>(null);
  const [extendDays, setExtendDays] = useState(30);

  // Cancel Modal State
  const [cancelModalSub, setCancelModalSub] = useState<Subscription | null>(null);

  const fetchSubscriptions = useCallback(async () => {
    try {
      setLoading(true);
      const res = await subscriptionService.listSubscriptions({
        search: search.trim() || undefined,
        status: statusFilter,
        page,
        limit: 10,
      });
      setSubscriptions(res.items);
      setTotal(res.total);
      setTotalPages(res.totalPages);
    } catch (err: unknown) {
      const e = err as { message?: string };
      toast.error('Failed to load subscriptions', e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [search, statusFilter, page, toast]);

  useEffect(() => {
    fetchSubscriptions();
  }, [fetchSubscriptions]);

  // Load plans & customers once for grant dropdown
  useEffect(() => {
    planService.listPlans().then(setPlans).catch(() => {});
    customerService.listCustomers({ limit: 50 }).then((res) => setCustomers(res.items)).catch(() => {});
  }, []);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchSubscriptions();
  };

  // Grant Subscription
  const handleGrant = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!grantTenantId || !grantPlanId || !grantReason.trim()) {
      setGrantError('Please select a customer, a plan, and provide a mandatory administrative reason.');
      return;
    }

    try {
      setGrantSubmitting(true);
      setGrantError(null);
      const res = await subscriptionService.grantSubscription({
        tenant_id: grantTenantId,
        plan_id: grantPlanId,
        reason: grantReason.trim(),
      });
      toast.success('Subscription Granted', res.message);
      setSubscriptions((prev) => [res.data, ...prev]);
      setGrantModalOpen(false);
      setGrantTenantId('');
      setGrantPlanId('');
      setGrantReason('');
    } catch (err: unknown) {
      const e = err as { message?: string };
      setGrantError(e.message || 'Failed to grant subscription.');
    } finally {
      setGrantSubmitting(false);
    }
  };

  // Extend Subscription
  const handleExtend = async (reason: string) => {
    if (!extendModalSub) return;
    try {
      const res = await subscriptionService.extendSubscription(extendModalSub.id, {
        days: extendDays,
        reason,
      });
      toast.success('Subscription Extended', res.message);
      setSubscriptions((prev) => prev.map((s) => (s.id === res.data.id ? res.data : s)));
      setExtendModalSub(null);
    } catch (err: unknown) {
      const e = err as { message?: string };
      toast.error('Extension Failed', e.message);
      throw err;
    }
  };

  // Cancel Subscription
  const handleCancel = async (reason: string) => {
    if (!cancelModalSub) return;
    try {
      const res = await subscriptionService.cancelSubscription(cancelModalSub.id, { reason });
      toast.success('Subscription Cancelled', res.message);
      setSubscriptions((prev) => prev.map((s) => (s.id === res.data.id ? res.data : s)));
      setCancelModalSub(null);
    } catch (err: unknown) {
      const e = err as { message?: string };
      toast.error('Cancellation Failed', e.message);
      throw err;
    }
  };

  const columns: Column<Subscription>[] = [
    {
      key: 'tenant_name',
      header: 'Customer / Tenant',
      render: (s) => (
        <div>
          <div className="font-semibold text-zinc-900">{s.tenant_name}</div>
          <div className="text-[11px] text-zinc-400 font-mono">+{s.customer_phone}</div>
        </div>
      ),
    },
    {
      key: 'plan_name',
      header: 'Plan & Price Snapshot',
      render: (s) => (
        <div>
          <div className="font-semibold text-zinc-800">{s.plan_name}</div>
          <div className="text-[11px] text-zinc-500 font-mono tabular-nums">
            {s.source === 'MANUAL_GRANT' ? (
              <span className="text-blue-600 font-semibold">Courtesy Grant (0 TZS)</span>
            ) : (
              <span>Snapshot: TSh {s.price_snapshot.toLocaleString()}</span>
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (s) => <Badge status={s.status} />,
    },
    {
      key: 'days_remaining',
      header: 'Remaining',
      render: (s) => {
        const isExpiringSoon = s.days_remaining <= 3 && s.days_remaining > 0;
        const isExpired = s.days_remaining === 0 || s.status === 'EXPIRED';
        return (
          <div className="font-mono text-xs">
            <span
              className={`font-bold ${
                isExpired ? 'text-zinc-400' : isExpiringSoon ? 'text-amber-600' : 'text-emerald-700'
              }`}
            >
              {s.days_remaining} days
            </span>
            <div className="text-[10px] text-zinc-400">
              {s.expires_at ? new Date(s.expires_at).toLocaleDateString() : 'N/A'}
            </div>
          </div>
        );
      },
    },
    {
      key: 'source',
      header: 'Provisioning Source',
      render: (s) => (
        <span
          className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-md ${
            s.source === 'MANUAL_GRANT'
              ? 'bg-blue-50 text-blue-700 border border-blue-200'
              : 'bg-zinc-100 text-zinc-600'
          }`}
        >
          {s.source === 'MANUAL_GRANT' ? <Sparkles className="h-3 w-3" /> : <CreditCard className="h-3 w-3" />}
          <span>{s.source === 'MANUAL_GRANT' ? 'Manual Grant' : 'Online Payment'}</span>
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (s) => (
        <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
          {s.status !== 'CANCELLED' && (
            <button
              onClick={() => {
                setExtendModalSub(s);
                setExtendDays(30);
              }}
              className="px-2 py-1 rounded-md text-[11px] font-medium bg-zinc-100 hover:bg-zinc-200 text-zinc-700 transition-colors"
              title="Extend subscription duration"
            >
              Extend
            </button>
          )}

          {s.status !== 'CANCELLED' && (
            <button
              onClick={() => setCancelModalSub(s)}
              className="p-1 rounded-md text-zinc-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"
              title="Cancel Subscription"
            >
              <XCircle className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <AdminLayout onRefresh={handleRefresh} isRefreshing={refreshing}>
      <div className="space-y-5">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-zinc-900">
              Customer Subscriptions
            </h1>
            <p className="text-xs text-zinc-500 mt-1">
              Active entitlements, manual subscription grants, and lifecycle duration extensions.
            </p>
          </div>
          <button
            onClick={() => setGrantModalOpen(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-brand-600 text-xs font-medium text-white hover:bg-brand-700 transition-colors shadow-2xs"
          >
            <PlusCircle className="h-4 w-4" />
            <span>Grant Subscription</span>
          </button>
        </div>

        {/* Filter & Search Bar */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-3 bg-white border border-zinc-200 rounded-xl shadow-2xs">
          <div className="flex items-center gap-1 p-0.5 bg-zinc-100/80 rounded-lg w-full sm:w-auto overflow-x-auto">
            {(['ALL', 'ACTIVE', 'EXPIRING_SOON', 'EXPIRED', 'CANCELLED', 'MANUALLY_GRANTED'] as const).map(
              (tab) => (
                <button
                  key={tab}
                  onClick={() => {
                    setStatusFilter(tab);
                    setPage(1);
                  }}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                    statusFilter === tab
                      ? 'bg-white text-zinc-900 shadow-2xs font-semibold'
                      : 'text-zinc-600 hover:text-zinc-900'
                  }`}
                >
                  {tab === 'ALL'
                    ? 'All'
                    : tab === 'EXPIRING_SOON'
                    ? 'Expiring'
                    : tab === 'MANUALLY_GRANTED'
                    ? 'Granted'
                    : tab.charAt(0) + tab.slice(1).toLowerCase()}
                </button>
              )
            )}
          </div>

          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search by customer, phone, plan..."
              className="w-full pl-9 pr-3 py-1.5 text-xs bg-zinc-50 border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 focus:bg-white transition-all placeholder:text-zinc-400"
            />
          </div>
        </div>

        {/* Table */}
        <DataTable
          columns={columns}
          data={subscriptions}
          loading={loading}
          total={total}
          totalPages={totalPages}
          page={page}
          onPageChange={setPage}
          emptyTitle="No subscriptions found"
          emptyDescription="Try selecting another filter tab or clearing your search query."
          isFiltered={statusFilter !== 'ALL' || search.length > 0}
          onClearFilters={() => {
            setStatusFilter('ALL');
            setSearch('');
            setPage(1);
          }}
        />

        {/* Grant Subscription Modal */}
        <Modal
          isOpen={grantModalOpen}
          onClose={() => setGrantModalOpen(false)}
          title="Grant Subscription to Customer"
          description="Manually provision a subscription plan to a customer tenant without requiring payment."
        >
          <form onSubmit={handleGrant} className="space-y-4">
            {grantError && (
              <div className="p-3 text-xs rounded-md bg-rose-50 border border-rose-200 text-rose-700 font-medium">
                {grantError}
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-zinc-700 mb-1">
                Target Customer <span className="text-rose-500">*</span>
              </label>
              <select
                value={grantTenantId}
                onChange={(e) => setGrantTenantId(e.target.value)}
                disabled={grantSubmitting}
                className="w-full text-xs p-2.5 rounded-lg border border-zinc-300 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                required
              >
                <option value="">Select a customer account...</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.tenant_id}>
                    {c.name} ({c.tenant_name} — +{c.phone_number})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-zinc-700 mb-1">
                Subscription Plan <span className="text-rose-500">*</span>
              </label>
              <select
                value={grantPlanId}
                onChange={(e) => setGrantPlanId(e.target.value)}
                disabled={grantSubmitting}
                className="w-full text-xs p-2.5 rounded-lg border border-zinc-300 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                required
              >
                <option value="">Select plan to grant...</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.duration_days} days — Catalog price: {p.price.toLocaleString()} TZS)
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-zinc-700 mb-1">
                Administrative Reason <span className="text-rose-500">*</span>
              </label>
              <textarea
                rows={2}
                value={grantReason}
                onChange={(e) => setGrantReason(e.target.value)}
                disabled={grantSubmitting}
                placeholder="Reason for courtesy grant (e.g. Partner onboarding, VIP trial, service recovery)..."
                className="w-full text-xs p-2.5 rounded-lg border border-zinc-300 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                required
              />
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-zinc-100">
              <button
                type="button"
                onClick={() => setGrantModalOpen(false)}
                disabled={grantSubmitting}
                className="px-3.5 py-2 text-xs font-medium text-zinc-600 hover:text-zinc-800 hover:bg-zinc-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={grantSubmitting}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-all shadow-sm disabled:opacity-50"
              >
                {grantSubmitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <span>Grant Entitlement</span>
              </button>
            </div>
          </form>
        </Modal>

        {/* Extend Subscription Modal */}
        <ConfirmDialog
          isOpen={!!extendModalSub}
          onClose={() => setExtendModalSub(null)}
          onConfirm={handleExtend}
          title={`Extend Subscription: ${extendModalSub?.tenant_name}`}
          description={`Add additional days to "${extendModalSub?.plan_name}". Current expiry: ${
            extendModalSub?.expires_at ? new Date(extendModalSub.expires_at).toLocaleDateString() : 'N/A'
          }. Enter extension days and reason below:`}
          confirmLabel={`Add ${extendDays} Days`}
          severity="info"
          requireReason
          reasonPlaceholder="Specify reason for duration extension (e.g. Compensation for downtime, marketing promotion)..."
        />

        {/* Cancel Subscription Modal */}
        <ConfirmDialog
          isOpen={!!cancelModalSub}
          onClose={() => setCancelModalSub(null)}
          onConfirm={handleCancel}
          title={`Cancel Subscription: ${cancelModalSub?.tenant_name}`}
          description={`Cancelling this subscription will immediately revoke "${cancelModalSub?.tenant_name}" bot moderation capabilities. The customer will be prompted to purchase a renewal to resume.`}
          confirmLabel="Cancel Subscription"
          severity="danger"
          requireReason
          reasonPlaceholder="Specify mandatory reason for cancelling this customer's subscription..."
        />
      </div>
    </AdminLayout>
  );
}
