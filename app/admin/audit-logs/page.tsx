'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { DataTable, Column } from '@/components/common/DataTable';
import { Badge } from '@/components/common/Badge';
import { SlideOver } from '@/components/common/SlideOver';
import { useToast } from '@/components/common/Toast';
import { auditLogService } from '@/services';
import { PlatformAuditLog, PlatformAuditAction } from '@/types/auditLog';
import {
  FileText,
  Search,
  Eye,
  Shield,
  Clock,
  User,
  Database,
  Lock,
} from 'lucide-react';

export default function AuditLogsPage() {
  const toast = useToast();
  const [logs, setLogs] = useState<PlatformAuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [actionFilter, setActionFilter] = useState<PlatformAuditAction | 'ALL'>('ALL');
  const [refreshing, setRefreshing] = useState(false);

  const [selectedLog, setSelectedLog] = useState<PlatformAuditLog | null>(null);

  const fetchLogs = useCallback(async () => {
    try {
      setLoading(true);
      const res = await auditLogService.listAuditLogs({
        search: search.trim() || undefined,
        action: actionFilter,
        page,
        limit: 10,
      });
      setLogs(res.items);
      setTotal(res.total);
      setTotalPages(res.totalPages);
    } catch (err: unknown) {
      const e = err as { message?: string };
      toast.error('Failed to load audit logs', e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [search, actionFilter, page, toast]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchLogs();
  };

  const columns: Column<PlatformAuditLog>[] = [
    {
      key: 'created_at',
      header: 'Timestamp',
      render: (l) => (
        <div className="font-mono text-[11px] text-zinc-600">
          <div>{new Date(l.created_at).toLocaleDateString()}</div>
          <div className="text-[10px] text-zinc-400">
            {new Date(l.created_at).toLocaleTimeString()}
          </div>
        </div>
      ),
    },
    {
      key: 'action',
      header: 'Action Executed',
      render: (l) => <Badge status={l.action} />,
    },
    {
      key: 'actor_name',
      header: 'Operator & Role',
      render: (l) => (
        <div>
          <div className="font-semibold text-zinc-900">{l.actor_name}</div>
          <div className="text-[10px] font-mono text-zinc-400">{l.actor_role}</div>
        </div>
      ),
    },
    {
      key: 'resource_type',
      header: 'Target Resource',
      render: (l) => (
        <div>
          <span className="text-zinc-500 font-medium text-xs">{l.resource_type}</span>
          <div className="font-mono text-[10px] text-zinc-400 truncate max-w-[130px]">
            {l.resource_id}
          </div>
        </div>
      ),
    },
    {
      key: 'reason',
      header: 'Audit Reason',
      render: (l) => (
        <span className="text-xs text-zinc-700 italic max-w-xs line-clamp-1">
          &quot;{l.reason}&quot;
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Inspect',
      align: 'right',
      render: (l) => (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setSelectedLog(l);
          }}
          className="p-1.5 rounded-md hover:bg-zinc-100 text-zinc-400 hover:text-zinc-800 transition-colors"
          title="Inspect Audit Metadata"
        >
          <Eye className="h-3.5 w-3.5" />
        </button>
      ),
    },
  ];

  const actionFilterOptions: (PlatformAuditAction | 'ALL')[] = [
    'ALL',
    'TENANT_SUSPENDED',
    'TENANT_REACTIVATED',
    'TENANT_DEACTIVATED',
    'PLAN_UPDATED',
    'PLAN_STATUS_CHANGED',
    'PLAN_DELETED',
    'SUBSCRIPTION_GRANTED',
    'SUBSCRIPTION_EXTENDED',
    'SUBSCRIPTION_CANCELLED',
    'CONNECTION_DISCONNECTED',
  ];

  return (
    <AdminLayout onRefresh={handleRefresh} isRefreshing={refreshing}>
      <div className="space-y-5">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-zinc-900">
              Platform Audit Logs
            </h1>
            <p className="text-xs text-zinc-500 mt-1">
              Immutable forensic log of all administrative actions, tenant suspensions, plan mutations, and socket terminations.
            </p>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-zinc-100 border border-zinc-200 text-xs text-zinc-600 font-mono">
            <Lock className="h-3 w-3 text-zinc-400" />
            <span>Strict Immutability Enforced</span>
          </div>
        </div>

        {/* Filter & Search Bar */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-3 bg-white border border-zinc-200 rounded-xl shadow-2xs">
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <span className="text-xs text-zinc-500 font-medium">Filter Action:</span>
            <select
              value={actionFilter}
              onChange={(e) => {
                setActionFilter(e.target.value as PlatformAuditAction | 'ALL');
                setPage(1);
              }}
              className="text-xs p-1.5 rounded-lg border border-zinc-200 bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-brand-500 text-zinc-800 font-medium"
            >
              {actionFilterOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt === 'ALL' ? 'All Operations' : opt.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
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
              placeholder="Search actor, reason, resource..."
              className="w-full pl-9 pr-3 py-1.5 text-xs bg-zinc-50 border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 focus:bg-white transition-all placeholder:text-zinc-400"
            />
          </div>
        </div>

        {/* Table */}
        <DataTable
          columns={columns}
          data={logs}
          loading={loading}
          total={total}
          totalPages={totalPages}
          page={page}
          onPageChange={setPage}
          onRowClick={(l) => setSelectedLog(l)}
          emptyTitle="No audit logs match criteria"
          emptyDescription="Try selecting another action filter or clearing your search term."
          isFiltered={actionFilter !== 'ALL' || search.length > 0}
          onClearFilters={() => {
            setActionFilter('ALL');
            setSearch('');
            setPage(1);
          }}
        />

        {/* SlideOver Drawer for Raw JSON & Inspection */}
        <SlideOver
          isOpen={!!selectedLog}
          onClose={() => setSelectedLog(null)}
          title="Audit Entry Forensic Inspection"
          subtitle={selectedLog?.id}
        >
          {selectedLog && (
            <div className="space-y-6 text-xs">
              <div className="p-4 rounded-xl border border-zinc-200 bg-zinc-50/60 flex items-center justify-between">
                <div>
                  <span className="text-[10px] text-zinc-400 uppercase tracking-wider block font-semibold">
                    Action Type
                  </span>
                  <div className="text-sm font-bold text-zinc-900 mt-1 font-mono">
                    {selectedLog.action}
                  </div>
                </div>
                <Badge status={selectedLog.action} size="md" />
              </div>

              {/* Operator Identification */}
              <div className="space-y-3">
                <h3 className="font-semibold text-zinc-900 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                  <User className="h-4 w-4 text-zinc-500" />
                  Operator Identity
                </h3>
                <div className="p-3.5 rounded-lg border border-zinc-200 bg-white space-y-2">
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Actor Name</span>
                    <span className="font-semibold text-zinc-800">{selectedLog.actor_name}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Actor Role</span>
                    <span className="font-mono text-zinc-800">{selectedLog.actor_role}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Actor ID</span>
                    <span className="font-mono text-zinc-500 text-[10px]">{selectedLog.actor_id}</span>
                  </div>
                </div>
              </div>

              {/* Target & Reason */}
              <div className="space-y-3">
                <h3 className="font-semibold text-zinc-900 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                  <Database className="h-4 w-4 text-zinc-500" />
                  Target Resource & Reason
                </h3>
                <div className="p-3.5 rounded-lg border border-zinc-200 bg-white space-y-2.5">
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Resource Type</span>
                    <span className="font-bold text-zinc-800">{selectedLog.resource_type}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Resource ID</span>
                    <span className="font-mono text-zinc-700">{selectedLog.resource_id}</span>
                  </div>
                  <div className="pt-2 border-t border-zinc-100">
                    <span className="text-zinc-500 block mb-1">Administrative Reason</span>
                    <div className="p-2.5 rounded-md bg-zinc-50 border border-zinc-200 text-zinc-800 font-medium">
                      &quot;{selectedLog.reason}&quot;
                    </div>
                  </div>
                </div>
              </div>

              {/* Metadata Payload */}
              {selectedLog.metadata && (
                <div className="space-y-2">
                  <h3 className="font-semibold text-zinc-900 uppercase tracking-wider text-[11px]">
                    Structured Metadata Payload
                  </h3>
                  <pre className="p-3.5 rounded-lg border border-zinc-200 bg-zinc-900 text-emerald-400 font-mono text-[11px] overflow-x-auto">
                    {JSON.stringify(selectedLog.metadata, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </SlideOver>
      </div>
    </AdminLayout>
  );
}
