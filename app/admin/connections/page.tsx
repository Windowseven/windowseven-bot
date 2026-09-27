'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { DataTable, Column } from '@/components/common/DataTable';
import { Badge } from '@/components/common/Badge';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { SlideOver } from '@/components/common/SlideOver';
import { useToast } from '@/components/common/Toast';
import { connectionService } from '@/services';
import { WhatsAppConnection, WhatsAppConnectionStatus } from '@/types/connection';
import {
  Radio,
  Search,
  PowerOff,
  Eye,
  Cpu,
  Clock,
  ShieldAlert,
  Server,
  Activity,
  Layers,
} from 'lucide-react';

export default function ConnectionsPage() {
  const toast = useToast();
  const [connections, setConnections] = useState<WhatsAppConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<WhatsAppConnectionStatus | 'ALL'>('ALL');
  const [refreshing, setRefreshing] = useState(false);

  const [selectedConnection, setSelectedConnection] = useState<WhatsAppConnection | null>(null);
  const [disconnectModalConn, setDisconnectModalConn] = useState<WhatsAppConnection | null>(null);

  const fetchConnections = useCallback(async () => {
    try {
      setLoading(true);
      const res = await connectionService.listConnections({
        search: search.trim() || undefined,
        status: statusFilter,
        page,
        limit: 10,
      });
      setConnections(res.items);
      setTotal(res.total);
      setTotalPages(res.totalPages);
    } catch (err: unknown) {
      const e = err as { message?: string };
      toast.error('Failed to load connections', e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [search, statusFilter, page, toast]);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchConnections();
  };

  const handleForceDisconnect = async (reason: string) => {
    if (!disconnectModalConn) return;
    try {
      const res = await connectionService.forceDisconnect(disconnectModalConn.id, { reason });
      toast.success('Connection Halted', res.message);
      setConnections((prev) => prev.map((c) => (c.id === res.data.id ? res.data : c)));
      if (selectedConnection?.id === res.data.id) {
        setSelectedConnection(res.data);
      }
      setDisconnectModalConn(null);
    } catch (err: unknown) {
      const e = err as { message?: string };
      toast.error('Force Disconnect Failed', e.message);
      throw err;
    }
  };

  const columns: Column<WhatsAppConnection>[] = [
    {
      key: 'tenant_name',
      header: 'Customer / Bot Identity',
      render: (c) => (
        <div>
          <div className="font-semibold text-zinc-900">{c.tenant_name}</div>
          <div className="text-[11px] text-zinc-400 font-mono">+{c.customer_phone}</div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Socket State',
      render: (c) => <Badge status={c.status} pulse={c.status === 'CONNECTED'} />,
    },
    {
      key: 'assigned_worker_id',
      header: 'Runtime Worker Lease',
      render: (c) => (
        <div>
          {c.assigned_worker_id ? (
            <div className="flex items-center gap-1.5 font-mono text-xs text-zinc-700">
              <Server className="h-3 w-3 text-emerald-600 shrink-0" />
              <span>{c.assigned_worker_id}</span>
            </div>
          ) : (
            <span className="text-zinc-400 text-xs italic font-mono">Unassigned</span>
          )}
          <div className="text-[10px] text-zinc-400 font-mono">Epoch #{c.lease_epoch}</div>
        </div>
      ),
    },
    {
      key: 'last_activity_at',
      header: 'Last Activity / Pulse',
      render: (c) => (
        <span className="text-[11px] text-zinc-500 font-mono">
          {c.last_activity_at ? new Date(c.last_activity_at).toLocaleTimeString() : 'Never'}
          <div className="text-[10px] text-zinc-400">
            {c.last_activity_at ? new Date(c.last_activity_at).toLocaleDateString() : ''}
          </div>
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
            onClick={() => setSelectedConnection(c)}
            className="p-1.5 rounded-md hover:bg-zinc-100 text-zinc-400 hover:text-zinc-800 transition-colors"
            title="Inspect Connection Details"
          >
            <Eye className="h-3.5 w-3.5" />
          </button>

          {c.status === 'CONNECTED' && (
            <button
              onClick={() => setDisconnectModalConn(c)}
              className="p-1.5 rounded-md hover:bg-rose-50 text-rose-500 hover:text-rose-700 transition-colors"
              title="Force Disconnect WhatsApp Socket"
            >
              <PowerOff className="h-3.5 w-3.5" />
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
              WhatsApp Socket Connections
            </h1>
            <p className="text-xs text-zinc-500 mt-1">
              Active Baileys Multi-Device WebSockets, worker node lease epochs, and control plane termination.
            </p>
          </div>
          <div className="text-xs text-zinc-500 font-mono">
            Active Sockets: <strong className="text-zinc-900">{total}</strong>
          </div>
        </div>

        {/* Filter & Search Bar */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-3 bg-white border border-zinc-200 rounded-xl shadow-2xs">
          <div className="flex items-center gap-1 p-0.5 bg-zinc-100/80 rounded-lg w-full sm:w-auto overflow-x-auto">
            {(['ALL', 'CONNECTED', 'CONNECTING', 'DISCONNECTED', 'ERROR', 'STOPPED'] as const).map(
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
                  {tab === 'ALL' ? 'All Sockets' : tab.charAt(0) + tab.slice(1).toLowerCase()}
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
              placeholder="Search by customer, phone, worker..."
              className="w-full pl-9 pr-3 py-1.5 text-xs bg-zinc-50 border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 focus:bg-white transition-all placeholder:text-zinc-400"
            />
          </div>
        </div>

        {/* Table */}
        <DataTable
          columns={columns}
          data={connections}
          loading={loading}
          total={total}
          totalPages={totalPages}
          page={page}
          onPageChange={setPage}
          onRowClick={(c) => setSelectedConnection(c)}
          emptyTitle="No WhatsApp connections found"
          emptyDescription="Try selecting another filter status or clearing your search query."
          isFiltered={statusFilter !== 'ALL' || search.length > 0}
          onClearFilters={() => {
            setStatusFilter('ALL');
            setSearch('');
            setPage(1);
          }}
        />

        {/* Detail Drawer */}
        <SlideOver
          isOpen={!!selectedConnection}
          onClose={() => setSelectedConnection(null)}
          title={`WhatsApp Socket: ${selectedConnection?.tenant_name}`}
          subtitle={selectedConnection?.id}
        >
          {selectedConnection && (
            <div className="space-y-6 text-xs">
              <div className="p-4 rounded-xl border border-zinc-200 bg-zinc-50/60 flex items-center justify-between">
                <div>
                  <span className="text-[10px] text-zinc-400 uppercase tracking-wider block font-semibold">
                    Current Connection State
                  </span>
                  <div className="text-base font-bold text-zinc-900 mt-1">
                    {selectedConnection.actual_state}
                  </div>
                </div>
                <Badge status={selectedConnection.status} size="md" pulse />
              </div>

              {/* Distributed Fencing Attributes */}
              <div className="space-y-3">
                <h3 className="font-semibold text-zinc-900 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                  <Server className="h-4 w-4 text-zinc-500" />
                  Distributed Worker Lease & Generation
                </h3>
                <div className="p-3.5 rounded-lg border border-zinc-200 bg-white space-y-2.5 font-mono text-[11px]">
                  <div className="flex justify-between">
                    <span className="text-zinc-400 font-sans">Assigned Worker Node</span>
                    <span className="font-bold text-zinc-900">
                      {selectedConnection.assigned_worker_id || 'None'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-400 font-sans">Lease Generation Epoch</span>
                    <span className="text-zinc-800 font-bold">#{selectedConnection.lease_epoch}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-400 font-sans">Desired State</span>
                    <span className="text-zinc-800">{selectedConnection.desired_state}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-400 font-sans">Actual Runtime State</span>
                    <span className="text-zinc-800">{selectedConnection.actual_state}</span>
                  </div>
                </div>
              </div>

              {/* Timestamps */}
              <div className="space-y-3">
                <h3 className="font-semibold text-zinc-900 uppercase tracking-wider text-[11px]">
                  Activity Timestamps
                </h3>
                <div className="p-3.5 rounded-lg border border-zinc-200 bg-white space-y-2">
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Last Connected</span>
                    <span className="font-mono text-zinc-800">
                      {selectedConnection.last_connected_at
                        ? new Date(selectedConnection.last_connected_at).toLocaleString()
                        : 'Never'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Last Heartbeat / Activity</span>
                    <span className="font-mono text-zinc-800">
                      {selectedConnection.last_activity_at
                        ? new Date(selectedConnection.last_activity_at).toLocaleString()
                        : 'Never'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Allocated Since</span>
                    <span className="font-mono text-zinc-800">
                      {new Date(selectedConnection.created_at).toLocaleString()}
                    </span>
                  </div>
                </div>
              </div>

              {selectedConnection.status === 'CONNECTED' && (
                <div className="pt-4 border-t border-zinc-200">
                  <button
                    onClick={() => setDisconnectModalConn(selectedConnection)}
                    className="w-full flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg border border-rose-300 bg-rose-50 hover:bg-rose-100 text-rose-700 font-medium transition-colors"
                  >
                    <PowerOff className="h-4 w-4" />
                    <span>Force Disconnect WhatsApp Socket</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </SlideOver>

        {/* Force Disconnect Confirmation Modal */}
        <ConfirmDialog
          isOpen={!!disconnectModalConn}
          onClose={() => setDisconnectModalConn(null)}
          onConfirm={handleForceDisconnect}
          title={`Force Disconnect: ${disconnectModalConn?.tenant_name}`}
          description={`Halting this socket will send a STOP_CONNECTION signal to worker "${disconnectModalConn?.assigned_worker_id || 'cluster'}", closing the active Baileys WebSocket immediately. The customer bot will stop answering WhatsApp messages until reconnected.`}
          confirmLabel="Force Disconnect Socket"
          severity="danger"
          requireReason
          reasonPlaceholder="Specify operational reason for terminating this connection (e.g. Socket crash recovery, compliance shutdown, worker maintenance)..."
        />
      </div>
    </AdminLayout>
  );
}
