'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { DataTable, Column } from '@/components/common/DataTable';
import { Badge } from '@/components/common/Badge';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { SlideOver } from '@/components/common/SlideOver';
import { useToast } from '@/components/common/Toast';
import { customerService } from '@/services';
import { Customer, TenantStatus, CustomerFilter } from '@/types/customer';
import {
  Search,
  SlidersHorizontal,
  UserX,
  UserCheck,
  Ban,
  Eye,
  ShieldAlert,
  Calendar,
  Phone,
  Mail,
  Building,
  Layers,
  Radio,
  Clock,
  ExternalLink,
} from 'lucide-react';

export default function CustomersPage() {
  const toast = useToast();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<TenantStatus | 'ALL'>('ALL');
  const [refreshing, setRefreshing] = useState(false);

  // Detail Drawer state
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);

  // Modal mutation states
  const [suspendModalCustomer, setSuspendModalCustomer] = useState<Customer | null>(null);
  const [reactivateModalCustomer, setReactivateModalCustomer] = useState<Customer | null>(null);
  const [deactivateModalCustomer, setDeactivateModalCustomer] = useState<Customer | null>(null);

  const fetchCustomers = useCallback(async () => {
    try {
      setLoading(true);
      const res = await customerService.listCustomers({
        search: search.trim() || undefined,
        status: statusFilter,
        page,
        limit: 10,
        sortBy: 'created_at',
        sortOrder: 'desc',
      });
      setCustomers(res.items);
      setTotal(res.total);
      setTotalPages(res.totalPages);
    } catch (err: unknown) {
      const e = err as { message?: string };
      toast.error('Failed to load customers', e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [search, statusFilter, page, toast]);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchCustomers();
  };

  // Mutation Handlers
  const handleSuspend = async (reason: string) => {
    if (!suspendModalCustomer) return;
    try {
      const res = await customerService.suspendCustomer(suspendModalCustomer.id, { reason });
      toast.success('Customer Suspended', res.message);
      // Update local state immediately
      setCustomers((prev) =>
        prev.map((c) => (c.id === res.data.id ? res.data : c))
      );
      if (selectedCustomer?.id === res.data.id) {
        setSelectedCustomer(res.data);
      }
    } catch (err: unknown) {
      const e = err as { message?: string };
      toast.error('Suspension Failed', e.message);
      throw err;
    }
  };

  const handleReactivate = async (reason: string) => {
    if (!reactivateModalCustomer) return;
    try {
      const res = await customerService.reactivateCustomer(reactivateModalCustomer.id, { reason });
      toast.success('Customer Reactivated', res.message);
      setCustomers((prev) =>
        prev.map((c) => (c.id === res.data.id ? res.data : c))
      );
      if (selectedCustomer?.id === res.data.id) {
        setSelectedCustomer(res.data);
      }
    } catch (err: unknown) {
      const e = err as { message?: string };
      toast.error('Reactivation Failed', e.message);
      throw err;
    }
  };

  const handleDeactivate = async (reason: string, confirmName?: string) => {
    if (!deactivateModalCustomer) return;
    try {
      const res = await customerService.deactivateCustomer(deactivateModalCustomer.id, {
        reason,
        confirmTenantName: confirmName || '',
      });
      toast.success('Customer Deactivated', res.message);
      setCustomers((prev) =>
        prev.map((c) => (c.id === res.data.id ? res.data : c))
      );
      if (selectedCustomer?.id === res.data.id) {
        setSelectedCustomer(res.data);
      }
    } catch (err: unknown) {
      const e = err as { message?: string };
      toast.error('Deactivation Failed', e.message);
      throw err;
    }
  };

  const columns: Column<Customer>[] = [
    {
      key: 'name',
      header: 'Customer / Tenant',
      sortable: true,
      render: (c) => (
        <div>
          <div className="font-semibold text-zinc-900 hover:text-brand-600 transition-colors">
            {c.name}
          </div>
          <div className="text-[11px] text-zinc-400 font-mono mt-0.5">{c.tenant_name}</div>
        </div>
      ),
    },
    {
      key: 'phone_number',
      header: 'Contact',
      render: (c) => (
        <div className="space-y-0.5">
          <div className="font-mono text-xs text-zinc-700">+{c.phone_number}</div>
          <div className="text-[11px] text-zinc-400 truncate max-w-[160px]">{c.email}</div>
        </div>
      ),
    },
    {
      key: 'tenant_status',
      header: 'Account Status',
      render: (c) => <Badge status={c.tenant_status} />,
    },
    {
      key: 'subscription_status',
      header: 'Subscription',
      render: (c) => (
        <div className="space-y-0.5">
          <Badge status={c.subscription_status} />
          {c.current_plan_name && (
            <div className="text-[10px] text-zinc-500 font-medium">
              {c.current_plan_name} ({c.days_remaining}d left)
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'connection_state',
      header: 'WhatsApp State',
      render: (c) => <Badge status={c.connection_state} pulse={c.connection_state === 'CONNECTED'} />,
    },
    {
      key: 'created_at',
      header: 'Created',
      render: (c) => (
        <span className="text-[11px] text-zinc-500 font-mono">
          {new Date(c.created_at).toLocaleDateString()}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (c) => (
        <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => setSelectedCustomer(c)}
            className="p-1.5 rounded-md hover:bg-zinc-100 text-zinc-500 hover:text-zinc-800 transition-colors"
            title="Inspect Details"
          >
            <Eye className="h-3.5 w-3.5" />
          </button>

          {c.tenant_status === 'ACTIVE' && (
            <button
              onClick={() => setSuspendModalCustomer(c)}
              className="p-1.5 rounded-md hover:bg-amber-50 text-amber-600 hover:text-amber-700 transition-colors"
              title="Suspend Customer"
            >
              <UserX className="h-3.5 w-3.5" />
            </button>
          )}

          {c.tenant_status === 'SUSPENDED' && (
            <button
              onClick={() => setReactivateModalCustomer(c)}
              className="p-1.5 rounded-md hover:bg-emerald-50 text-emerald-600 hover:text-emerald-700 transition-colors"
              title="Reactivate Customer"
            >
              <UserCheck className="h-3.5 w-3.5" />
            </button>
          )}

          {c.tenant_status !== 'DEACTIVATED' && (
            <button
              onClick={() => setDeactivateModalCustomer(c)}
              className="p-1.5 rounded-md hover:bg-rose-50 text-rose-500 hover:text-rose-700 transition-colors"
              title="Deactivate Customer (Terminal)"
            >
              <Ban className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <AdminLayout onRefresh={handleRefresh} isRefreshing={refreshing}>
      <div className="space-y-5">
        {/* Page Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-zinc-900">Customer Accounts</h1>
            <p className="text-xs text-zinc-500 mt-1">
              Authoritative workspace inspection, account suspension governance, and tenancy management.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="font-mono text-zinc-500">
              Total Customers: <strong className="text-zinc-900">{total}</strong>
            </span>
          </div>
        </div>

        {/* Filter & Search Bar */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-3 bg-white border border-zinc-200 rounded-xl shadow-2xs">
          {/* Status Tabs */}
          <div className="flex items-center gap-1 p-0.5 bg-zinc-100/80 rounded-lg w-full sm:w-auto overflow-x-auto">
            {(['ALL', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const).map((tab) => (
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
                {tab === 'ALL' ? 'All Accounts' : tab.charAt(0) + tab.slice(1).toLowerCase()}
              </button>
            ))}
          </div>

          {/* Search Box */}
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search by name, phone, email..."
              className="w-full pl-9 pr-3 py-1.5 text-xs bg-zinc-50 border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 focus:bg-white transition-all placeholder:text-zinc-400"
            />
          </div>
        </div>

        {/* Data Table */}
        <DataTable
          columns={columns}
          data={customers}
          loading={loading}
          total={total}
          totalPages={totalPages}
          page={page}
          onPageChange={setPage}
          onRowClick={(c) => setSelectedCustomer(c)}
          emptyTitle="No customers match criteria"
          emptyDescription="Try clearing your search query or switching your status filter."
          isFiltered={statusFilter !== 'ALL' || search.length > 0}
          onClearFilters={() => {
            setStatusFilter('ALL');
            setSearch('');
            setPage(1);
          }}
        />

        {/* Customer Detail Drawer */}
        <SlideOver
          isOpen={!!selectedCustomer}
          onClose={() => setSelectedCustomer(null)}
          title={selectedCustomer?.name || 'Customer Details'}
          subtitle={selectedCustomer?.tenant_id}
        >
          {selectedCustomer && (
            <div className="space-y-6 text-xs">
              {/* Account Status Card */}
              <div className="p-4 rounded-xl border border-zinc-200 bg-zinc-50/60 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-zinc-700 uppercase tracking-wider text-[10px]">
                    Current Account State
                  </span>
                  <Badge status={selectedCustomer.tenant_status} size="md" />
                </div>
                {selectedCustomer.metadata?.last_reason && (
                  <div className="p-2.5 rounded-lg bg-white border border-zinc-200 text-zinc-600">
                    <span className="font-semibold text-zinc-800">Last Action Reason: </span>
                    {selectedCustomer.metadata.last_reason}
                  </div>
                )}
              </div>

              {/* Customer Attributes */}
              <div className="space-y-3">
                <h3 className="font-semibold text-zinc-900 uppercase tracking-wider text-[11px]">
                  Customer Identity & Tenant
                </h3>
                <div className="grid grid-cols-2 gap-3 p-3.5 rounded-lg border border-zinc-200 bg-white">
                  <div>
                    <span className="text-zinc-400 block text-[10px]">Tenant Name</span>
                    <span className="font-semibold text-zinc-800">{selectedCustomer.tenant_name}</span>
                  </div>
                  <div>
                    <span className="text-zinc-400 block text-[10px]">Tenant ID</span>
                    <span className="font-mono text-zinc-700 truncate block">
                      {selectedCustomer.tenant_id}
                    </span>
                  </div>
                  <div>
                    <span className="text-zinc-400 block text-[10px]">Phone Number</span>
                    <span className="font-mono text-zinc-800">+{selectedCustomer.phone_number}</span>
                  </div>
                  <div>
                    <span className="text-zinc-400 block text-[10px]">Email Address</span>
                    <span className="text-zinc-800 truncate block">{selectedCustomer.email}</span>
                  </div>
                </div>
              </div>

              {/* Subscription Details */}
              <div className="space-y-3">
                <h3 className="font-semibold text-zinc-900 uppercase tracking-wider text-[11px]">
                  Subscription Entitlement
                </h3>
                <div className="p-3.5 rounded-lg border border-zinc-200 bg-white space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-500">Plan</span>
                    <span className="font-semibold text-zinc-900">
                      {selectedCustomer.current_plan_name || 'None'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-500">Subscription Status</span>
                    <Badge status={selectedCustomer.subscription_status} />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-500">Days Remaining</span>
                    <span className="font-mono font-bold text-zinc-900">
                      {selectedCustomer.days_remaining} days
                    </span>
                  </div>
                  {selectedCustomer.subscription_expires_at && (
                    <div className="flex items-center justify-between">
                      <span className="text-zinc-500">Expires At</span>
                      <span className="font-mono text-zinc-700">
                        {new Date(selectedCustomer.subscription_expires_at).toLocaleString()}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* WhatsApp State */}
              <div className="space-y-3">
                <h3 className="font-semibold text-zinc-900 uppercase tracking-wider text-[11px]">
                  WhatsApp Connection
                </h3>
                <div className="p-3.5 rounded-lg border border-zinc-200 bg-white flex items-center justify-between">
                  <div>
                    <div className="font-semibold text-zinc-800">1:1 Tenant WhatsApp Socket</div>
                    <div className="text-[11px] text-zinc-500">Managed via Baileys Multi-Device</div>
                  </div>
                  <Badge status={selectedCustomer.connection_state} pulse />
                </div>
              </div>

              {/* Operational Metadata */}
              {selectedCustomer.metadata && (
                <div className="space-y-3">
                  <h3 className="font-semibold text-zinc-900 uppercase tracking-wider text-[11px]">
                    Operational Telemetry
                  </h3>
                  <div className="grid grid-cols-2 gap-3 p-3.5 rounded-lg border border-zinc-200 bg-zinc-50">
                    <div>
                      <span className="text-zinc-400 block text-[10px]">Managed WhatsApp Groups</span>
                      <span className="font-mono font-bold text-zinc-800">
                        {selectedCustomer.metadata.groups_count ?? 0}
                      </span>
                    </div>
                    <div>
                      <span className="text-zinc-400 block text-[10px]">Messages Moderated</span>
                      <span className="font-mono font-bold text-zinc-800">
                        {selectedCustomer.metadata.messages_moderated?.toLocaleString() ?? 0}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Action Buttons in Drawer */}
              <div className="pt-4 border-t border-zinc-200 flex flex-col gap-2">
                {selectedCustomer.tenant_status === 'ACTIVE' && (
                  <button
                    onClick={() => {
                      setSuspendModalCustomer(selectedCustomer);
                    }}
                    className="w-full flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-800 font-medium transition-colors"
                  >
                    <UserX className="h-4 w-4" />
                    <span>Suspend Customer Account</span>
                  </button>
                )}

                {selectedCustomer.tenant_status === 'SUSPENDED' && (
                  <button
                    onClick={() => {
                      setReactivateModalCustomer(selectedCustomer);
                    }}
                    className="w-full flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium transition-colors"
                  >
                    <UserCheck className="h-4 w-4" />
                    <span>Reactivate Customer Account</span>
                  </button>
                )}

                {selectedCustomer.tenant_status !== 'DEACTIVATED' && (
                  <button
                    onClick={() => {
                      setDeactivateModalCustomer(selectedCustomer);
                    }}
                    className="w-full flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg border border-rose-300 bg-rose-50 hover:bg-rose-100 text-rose-700 font-medium transition-colors"
                  >
                    <Ban className="h-4 w-4" />
                    <span>Deactivate Customer (Terminal)</span>
                  </button>
                )}
              </div>
            </div>
          )}
        </SlideOver>

        {/* Suspend Confirmation Modal */}
        <ConfirmDialog
          isOpen={!!suspendModalCustomer}
          onClose={() => setSuspendModalCustomer(null)}
          onConfirm={handleSuspend}
          title="Suspend Customer Account"
          description={`Suspending "${suspendModalCustomer?.name}" (${suspendModalCustomer?.tenant_name}) will immediately stop their active WhatsApp connection, block customer API mutations, and pause moderation activities.`}
          confirmLabel="Suspend Customer"
          severity="warning"
          requireReason
          reasonPlaceholder="State the specific reason for suspension (e.g. Terms of Service violation, spam reports, or administrative review)..."
        />

        {/* Reactivate Confirmation Modal */}
        <ConfirmDialog
          isOpen={!!reactivateModalCustomer}
          onClose={() => setReactivateModalCustomer(null)}
          onConfirm={handleReactivate}
          title="Reactivate Customer Account"
          description={`Reactivating "${reactivateModalCustomer?.name}" will restore customer access, allowing them to reconnect their WhatsApp bot and resume moderation.`}
          confirmLabel="Reactivate Customer"
          severity="info"
          requireReason
          reasonPlaceholder="State the resolution reason for reactivation..."
        />

        {/* Deactivate Terminal Modal (With Name Confirmation) */}
        <ConfirmDialog
          isOpen={!!deactivateModalCustomer}
          onClose={() => setDeactivateModalCustomer(null)}
          onConfirm={handleDeactivate}
          title="Deactivate Customer Account (TERMINAL)"
          description={`CRITICAL: Deactivation of "${deactivateModalCustomer?.name}" is a PERMANENT, TERMINAL operation. The tenant workspace will be shut down, all active subscriptions cancelled, and the WhatsApp socket disconnected.`}
          confirmLabel="Permanently Deactivate"
          severity="danger"
          requireReason
          reasonPlaceholder="Mandatory compliance or legal justification for account deactivation..."
          requiredConfirmationText={deactivateModalCustomer?.tenant_name}
        />
      </div>
    </AdminLayout>
  );
}
