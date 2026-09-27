'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { StatCard } from '@/components/common/StatCard';
import { Badge } from '@/components/common/Badge';
import { Skeleton } from '@/components/common/Skeleton';
import { overviewService } from '@/services';
import { OverviewMetrics } from '@/types/overview';
import {
  Users,
  CreditCard,
  Receipt,
  Radio,
  Clock,
  ArrowRight,
  TrendingUp,
  Activity,
  Layers,
  AlertTriangle,
} from 'lucide-react';
import Link from 'next/link';

export default function OverviewPage() {
  const [metrics, setMetrics] = useState<OverviewMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchMetrics = useCallback(async () => {
    try {
      setError(null);
      const data = await overviewService.getOverviewMetrics();
      setMetrics(data);
    } catch (err: unknown) {
      const e = err as { message?: string };
      setError(e.message || 'Failed to fetch platform overview metrics.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchMetrics();
  };

  return (
    <AdminLayout onRefresh={handleRefresh} isRefreshing={refreshing}>
      <div className="space-y-6">
        {/* Welcome & System Banner */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-zinc-200 gap-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-zinc-900">
              Operational Control Center
            </h1>
            <p className="text-xs text-zinc-500 mt-1">
              Live operational telemetry, customer tenancy health, and WhatsApp connection state across Windowseven.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/admin/customers"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-300 bg-white text-xs font-medium text-zinc-700 hover:bg-zinc-50 hover:border-zinc-400 transition-colors shadow-2xs"
            >
              <Users className="h-3.5 w-3.5 text-zinc-500" />
              <span>Manage Customers</span>
            </Link>
            <Link
              href="/admin/plans"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-600 text-xs font-medium text-white hover:bg-brand-700 transition-colors shadow-2xs"
            >
              <Layers className="h-3.5 w-3.5" />
              <span>Review Plans</span>
            </Link>
          </div>
        </div>

        {error && (
          <div className="p-4 rounded-xl border border-rose-200 bg-rose-50 text-xs text-rose-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-rose-600 shrink-0" />
              <span>{error}</span>
            </div>
            <button
              onClick={handleRefresh}
              className="font-semibold underline hover:text-rose-900 text-xs"
            >
              Retry
            </button>
          </div>
        )}

        {/* Primary Metric Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="p-5 rounded-xl bg-white border border-zinc-200 space-y-3">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-8 w-16" />
                <Skeleton className="h-3 w-32" />
              </div>
            ))
          ) : metrics ? (
            <>
              <StatCard
                title="Active Customers"
                value={metrics.activeCustomers}
                subtitle={`${metrics.totalCustomers} total accounts (${metrics.suspendedCustomers} suspended)`}
                icon={Users}
                badge={{
                  label: `${Math.round((metrics.activeCustomers / metrics.totalCustomers) * 100)}% healthy`,
                  variant: 'positive',
                }}
              />
              <StatCard
                title="Active Subscriptions"
                value={metrics.activeSubscriptions}
                subtitle={`${metrics.expiringSubscriptions} renewal notices active (<= 72h)`}
                icon={CreditCard}
                badge={
                  metrics.expiringSubscriptions > 0
                    ? { label: `${metrics.expiringSubscriptions} Expiring`, variant: 'warning' }
                    : { label: 'Optimal', variant: 'positive' }
                }
              />
              <StatCard
                title="Payment Volume (TZS)"
                value={`TSh ${metrics.totalPaymentVolumeTZS.toLocaleString()}`}
                subtitle={`${metrics.successfulPaymentsCount} successful transactions (${metrics.pendingPaymentsCount} pending)`}
                icon={Receipt}
                badge={{ label: 'FastLipa Realtime', variant: 'positive' }}
              />
              <StatCard
                title="Connected WhatsApp Bots"
                value={metrics.connectedWhatsAppAccounts}
                subtitle={`${metrics.disconnectedWhatsAppAccounts} sockets offline / standby`}
                icon={Radio}
                badge={
                  metrics.connectedWhatsAppAccounts > 0
                    ? { label: 'Sockets Active', variant: 'positive' }
                    : { label: 'No Active Sockets', variant: 'neutral' }
                }
              />
            </>
          ) : null}
        </div>

        {/* Operational Section: Sub-metrics and Live Activity */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Quick Health Breakdown */}
          <div className="lg:col-span-1 p-5 rounded-xl bg-white border border-zinc-200/90 shadow-xs space-y-4">
            <div className="flex items-center justify-between border-b border-zinc-100 pb-3">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-600 flex items-center gap-2">
                <Activity className="h-4 w-4 text-brand-600" />
                Cluster Health Summary
              </h2>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                100% Operational
              </span>
            </div>

            {loading ? (
              <div className="space-y-3">
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-full" />
              </div>
            ) : metrics ? (
              <div className="space-y-3.5 text-xs">
                <div className="flex items-center justify-between p-2.5 rounded-lg bg-zinc-50 border border-zinc-100">
                  <span className="text-zinc-600">Active Tenant Workspaces</span>
                  <span className="font-mono font-bold text-zinc-900">{metrics.activeCustomers}</span>
                </div>
                <div className="flex items-center justify-between p-2.5 rounded-lg bg-zinc-50 border border-zinc-100">
                  <span className="text-zinc-600">Suspended / Deactivated</span>
                  <span className="font-mono font-bold text-zinc-900">
                    {metrics.suspendedCustomers + metrics.deactivatedCustomers}
                  </span>
                </div>
                <div className="flex items-center justify-between p-2.5 rounded-lg bg-zinc-50 border border-zinc-100">
                  <span className="text-zinc-600">Pending USSD Payments</span>
                  <span className="font-mono font-bold text-amber-600">{metrics.pendingPaymentsCount}</span>
                </div>
                <div className="flex items-center justify-between p-2.5 rounded-lg bg-zinc-50 border border-zinc-100">
                  <span className="text-zinc-600">Active Worker Leases</span>
                  <span className="font-mono font-bold text-emerald-600">2 Nodes Active</span>
                </div>
              </div>
            ) : null}

            <div className="pt-2 border-t border-zinc-100">
              <Link
                href="/admin/connections"
                className="text-xs font-medium text-brand-600 hover:text-brand-700 inline-flex items-center gap-1 group"
              >
                Inspect live worker sockets
                <ArrowRight className="h-3.5 w-3.5 group-hover:translate-x-0.5 transition-transform" />
              </Link>
            </div>
          </div>

          {/* Recent Operational Activity (Audit Stream) */}
          <div className="lg:col-span-2 p-5 rounded-xl bg-white border border-zinc-200/90 shadow-xs space-y-4">
            <div className="flex items-center justify-between border-b border-zinc-100 pb-3">
              <div>
                <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-600 flex items-center gap-2">
                  <Clock className="h-4 w-4 text-zinc-500" />
                  Recent Administrative Mutations
                </h2>
                <p className="text-[11px] text-zinc-400 mt-0.5">
                  Immutable forensic audit trail of recent control plane operations.
                </p>
              </div>
              <Link
                href="/admin/audit-logs"
                className="text-xs font-medium text-brand-600 hover:text-brand-700 inline-flex items-center gap-1"
              >
                <span>View all</span>
                <ArrowRight className="h-3 w-3" />
              </Link>
            </div>

            {loading ? (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : metrics && metrics.recentActivity.length > 0 ? (
              <div className="divide-y divide-zinc-100">
                {metrics.recentActivity.map((log) => (
                  <div key={log.id} className="py-2.5 flex items-start justify-between gap-3 text-xs">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Badge status={log.action} size="sm" />
                        <span className="font-semibold text-zinc-800">{log.actor_name}</span>
                        <span className="text-[10px] text-zinc-400 font-mono">({log.actor_role})</span>
                      </div>
                      <p className="text-zinc-600 line-clamp-1 italic text-[11px] pl-1">
                        &quot;{log.reason}&quot;
                      </p>
                    </div>
                    <div className="text-[10px] font-mono text-zinc-400 shrink-0 text-right">
                      {new Date(log.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      <div className="text-[9px]">{new Date(log.created_at).toLocaleDateString()}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-zinc-500 py-6 text-center">No recent administrative mutations.</p>
            )}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
