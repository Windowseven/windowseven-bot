'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { DataTable, Column } from '@/components/common/DataTable';
import { Badge } from '@/components/common/Badge';
import { SlideOver } from '@/components/common/SlideOver';
import { useToast } from '@/components/common/Toast';
import { paymentService } from '@/services';
import { Payment, PaymentStatus } from '@/types/payment';
import {
  Receipt,
  Search,
  Eye,
  CheckCircle2,
  Clock,
  AlertCircle,
  Phone,
  Calendar,
  Layers,
  Building,
  Info,
} from 'lucide-react';

export default function PaymentsPage() {
  const toast = useToast();
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<PaymentStatus | 'ALL'>('ALL');
  const [refreshing, setRefreshing] = useState(false);

  const [selectedPayment, setSelectedPayment] = useState<Payment | null>(null);

  const fetchPayments = useCallback(async () => {
    try {
      setLoading(true);
      const res = await paymentService.listPayments({
        search: search.trim() || undefined,
        status: statusFilter,
        page,
        limit: 10,
      });
      setPayments(res.items);
      setTotal(res.total);
      setTotalPages(res.totalPages);
    } catch (err: unknown) {
      const e = err as { message?: string };
      toast.error('Failed to load payments', e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [search, statusFilter, page, toast]);

  useEffect(() => {
    fetchPayments();
  }, [fetchPayments]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchPayments();
  };

  const columns: Column<Payment>[] = [
    {
      key: 'transaction_reference',
      header: 'Reference & ID',
      render: (p) => (
        <div>
          <div className="font-mono font-bold text-zinc-900 tracking-wide">
            {p.transaction_reference}
          </div>
          {p.provider_reference && (
            <div className="text-[10px] text-zinc-400 font-mono">
              Provider: {p.provider_reference}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'tenant_name',
      header: 'Customer / Payer',
      render: (p) => (
        <div>
          <div className="font-semibold text-zinc-800">{p.tenant_name}</div>
          <div className="text-[11px] text-zinc-400 font-mono">+{p.customer_phone}</div>
        </div>
      ),
    },
    {
      key: 'plan_name',
      header: 'Plan Purchased',
      render: (p) => (
        <span className="text-xs font-medium text-zinc-700">{p.plan_name}</span>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      render: (p) => (
        <div className="font-mono font-bold text-xs text-zinc-900 tabular-nums">
          TSh {p.amount.toLocaleString()}
          <span className="text-[10px] text-zinc-400 ml-1 font-normal">{p.currency}</span>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Payment Status',
      render: (p) => <Badge status={p.status} />,
    },
    {
      key: 'created_at',
      header: 'Transaction Date',
      render: (p) => (
        <div className="text-[11px] text-zinc-500 font-mono">
          <div>{new Date(p.created_at).toLocaleDateString()}</div>
          <div className="text-[10px] text-zinc-400">
            {new Date(p.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Inspect',
      align: 'right',
      render: (p) => (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setSelectedPayment(p);
          }}
          className="p-1.5 rounded-md hover:bg-zinc-100 text-zinc-400 hover:text-zinc-800 transition-colors"
          title="View Payment Details"
        >
          <Eye className="h-3.5 w-3.5" />
        </button>
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
              Payment Transactions
            </h1>
            <p className="text-xs text-zinc-500 mt-1">
              Read-only inspection of incoming customer subscription payments and mobile money settlements.
            </p>
          </div>
          <div className="text-xs text-zinc-500 font-mono">
            Total Transactions: <strong className="text-zinc-900">{total}</strong>
          </div>
        </div>

        {/* Filter & Search Bar */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-3 bg-white border border-zinc-200 rounded-xl shadow-2xs">
          <div className="flex items-center gap-1 p-0.5 bg-zinc-100/80 rounded-lg w-full sm:w-auto overflow-x-auto">
            {(['ALL', 'SUCCESS', 'PENDING', 'FAILED'] as const).map((tab) => (
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
                {tab === 'ALL' ? 'All Transactions' : tab.charAt(0) + tab.slice(1).toLowerCase()}
              </button>
            ))}
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
              placeholder="Search reference, customer, phone..."
              className="w-full pl-9 pr-3 py-1.5 text-xs bg-zinc-50 border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 focus:bg-white transition-all placeholder:text-zinc-400"
            />
          </div>
        </div>

        {/* Table */}
        <DataTable
          columns={columns}
          data={payments}
          loading={loading}
          total={total}
          totalPages={totalPages}
          page={page}
          onPageChange={setPage}
          onRowClick={(p) => setSelectedPayment(p)}
          emptyTitle="No payments found"
          emptyDescription="Try selecting another filter status or clearing your search query."
          isFiltered={statusFilter !== 'ALL' || search.length > 0}
          onClearFilters={() => {
            setStatusFilter('ALL');
            setSearch('');
            setPage(1);
          }}
        />

        {/* Payment Detail Drawer */}
        <SlideOver
          isOpen={!!selectedPayment}
          onClose={() => setSelectedPayment(null)}
          title={`Payment: ${selectedPayment?.transaction_reference}`}
          subtitle={selectedPayment?.id}
        >
          {selectedPayment && (
            <div className="space-y-6 text-xs">
              {/* Payment Status Summary */}
              <div className="p-4 rounded-xl border border-zinc-200 bg-zinc-50/60 flex items-center justify-between">
                <div>
                  <span className="text-[10px] text-zinc-400 uppercase tracking-wider block font-semibold">
                    Settlement Status
                  </span>
                  <div className="text-xl font-bold font-mono text-zinc-900 mt-1 tabular-nums">
                    TSh {selectedPayment.amount.toLocaleString()} {selectedPayment.currency}
                  </div>
                </div>
                <Badge status={selectedPayment.status} size="md" />
              </div>

              {selectedPayment.failure_reason && (
                <div className="p-3.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 space-y-1">
                  <div className="font-semibold text-xs flex items-center gap-1.5 text-rose-900">
                    <AlertCircle className="h-4 w-4 text-rose-600" />
                    Provider Rejection Reason
                  </div>
                  <p className="text-[11px] leading-relaxed">{selectedPayment.failure_reason}</p>
                </div>
              )}

              {/* Transaction Attributes */}
              <div className="space-y-3">
                <h3 className="font-semibold text-zinc-900 uppercase tracking-wider text-[11px]">
                  Transaction Identifiers
                </h3>
                <div className="p-3.5 rounded-lg border border-zinc-200 bg-white space-y-2.5 font-mono text-[11px]">
                  <div className="flex justify-between">
                    <span className="text-zinc-400 font-sans">Windowseven Reference</span>
                    <span className="font-bold text-zinc-900">{selectedPayment.transaction_reference}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-400 font-sans">Provider Reference</span>
                    <span className="text-zinc-700">{selectedPayment.provider_reference || 'N/A'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-400 font-sans">Internal UUID</span>
                    <span className="text-zinc-500 text-[10px] truncate max-w-[200px]">{selectedPayment.id}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-400 font-sans">Recorded Timestamp</span>
                    <span className="text-zinc-700">{new Date(selectedPayment.created_at).toLocaleString()}</span>
                  </div>
                </div>
              </div>

              {/* Customer & Plan Details */}
              <div className="space-y-3">
                <h3 className="font-semibold text-zinc-900 uppercase tracking-wider text-[11px]">
                  Customer & Plan Purchased
                </h3>
                <div className="p-3.5 rounded-lg border border-zinc-200 bg-white space-y-2">
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Payer Name</span>
                    <span className="font-semibold text-zinc-800">{selectedPayment.tenant_name}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Payer Phone</span>
                    <span className="font-mono text-zinc-800">+{selectedPayment.customer_phone}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Payer Email</span>
                    <span className="text-zinc-800">{selectedPayment.customer_email}</span>
                  </div>
                  <div className="flex justify-between pt-2 border-t border-zinc-100">
                    <span className="text-zinc-500">Purchased Plan</span>
                    <span className="font-semibold text-brand-600">{selectedPayment.plan_name}</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </SlideOver>
      </div>
    </AdminLayout>
  );
}
