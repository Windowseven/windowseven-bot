'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Badge } from '@/components/common/Badge';
import { Modal } from '@/components/common/Modal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Skeleton } from '@/components/common/Skeleton';
import { useToast } from '@/components/common/Toast';
import { planService } from '@/services';
import { Plan } from '@/types/plan';
import {
  Layers,
  Edit2,
  Trash2,
  ToggleLeft,
  ToggleRight,
  Info,
  Calendar,
  Clock,
  ShieldAlert,
  Loader2,
  CheckCircle,
} from 'lucide-react';

export default function PlansPage() {
  const toast = useToast();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Edit Price Modal
  const [priceModalPlan, setPriceModalPlan] = useState<Plan | null>(null);
  const [newPrice, setNewPrice] = useState<number>(0);
  const [priceSubmitting, setPriceSubmitting] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);

  // Status Toggle Modal
  const [statusModalPlan, setStatusModalPlan] = useState<Plan | null>(null);

  // Delete Plan Modal
  const [deleteModalPlan, setDeleteModalPlan] = useState<Plan | null>(null);

  const fetchPlans = useCallback(async () => {
    try {
      setLoading(true);
      const data = await planService.listPlans();
      setPlans(data);
    } catch (err: unknown) {
      const e = err as { message?: string };
      toast.error('Failed to load plans', e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchPlans();
  }, [fetchPlans]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchPlans();
  };

  // Price Update
  const handleOpenPriceModal = (plan: Plan) => {
    setPriceModalPlan(plan);
    setNewPrice(plan.price);
    setPriceError(null);
  };

  const handleUpdatePrice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!priceModalPlan) return;
    if (newPrice < 0 || isNaN(newPrice)) {
      setPriceError('Price must be a non-negative number.');
      return;
    }

    try {
      setPriceSubmitting(true);
      setPriceError(null);
      const res = await planService.updatePlanPrice(priceModalPlan.id, { price: newPrice });
      toast.success('Price Updated', res.message);
      setPlans((prev) => prev.map((p) => (p.id === res.data.id ? res.data : p)));
      setPriceModalPlan(null);
    } catch (err: unknown) {
      const e = err as { message?: string };
      setPriceError(e.message || 'Failed to update plan price.');
    } finally {
      setPriceSubmitting(false);
    }
  };

  // Status Change
  const handleToggleStatus = async () => {
    if (!statusModalPlan) return;
    const nextStatus = statusModalPlan.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    try {
      const res = await planService.setPlanStatus(statusModalPlan.id, { status: nextStatus });
      toast.success('Plan Status Changed', res.message);
      setPlans((prev) => prev.map((p) => (p.id === res.data.id ? res.data : p)));
      setStatusModalPlan(null);
    } catch (err: unknown) {
      const e = err as { message?: string };
      toast.error('Status Change Failed', e.message);
    }
  };

  // Delete Plan
  const handleDeletePlan = async () => {
    if (!deleteModalPlan) return;
    try {
      await planService.deletePlan(deleteModalPlan.id);
      toast.success('Plan Deleted', `Plan "${deleteModalPlan.name}" was removed.`);
      setPlans((prev) => prev.filter((p) => p.id !== deleteModalPlan.id));
      setDeleteModalPlan(null);
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string };
      toast.error('Cannot Delete Plan', e.message);
      throw err;
    }
  };

  return (
    <AdminLayout onRefresh={handleRefresh} isRefreshing={refreshing}>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-2 border-b border-zinc-200 gap-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-zinc-900">
              Subscription Plans & Pricing
            </h1>
            <p className="text-xs text-zinc-500 mt-1">
              Configure product tiers, pricing, durations, and manage catalog availability.
            </p>
          </div>
        </div>

        {/* Historical Price Invariant Banner */}
        <div className="p-4 rounded-xl border border-blue-200 bg-blue-50/70 text-blue-900 text-xs flex items-start gap-3">
          <Info className="h-4 w-4 text-blue-600 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <span className="font-semibold text-blue-950">
              Historical Pricing Preservation Architecture
            </span>
            <p className="text-blue-800 leading-relaxed text-[11px]">
              Updating a plan’s current catalog price creates a new price point for new customer purchases.
              Existing customer subscriptions and completed payment records remain permanently anchored to their original snapshot prices (e.g. 10,000 TZS). Old receipts and subscriptions are never altered.
            </p>
          </div>
        </div>

        {/* Plans Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {loading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="p-5 rounded-xl bg-white border border-zinc-200 space-y-4">
                <Skeleton className="h-6 w-32" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-10 w-24" />
                <Skeleton className="h-8 w-full" />
              </div>
            ))
          ) : (
            plans.map((plan) => (
              <div
                key={plan.id}
                className={`flex flex-col justify-between p-5 rounded-xl border transition-all ${
                  plan.status === 'ACTIVE'
                    ? 'bg-white border-zinc-200/90 shadow-xs hover:border-zinc-300'
                    : 'bg-zinc-50/60 border-zinc-200 opacity-80'
                }`}
              >
                <div className="space-y-3">
                  {/* Plan Top Badges */}
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">
                      {plan.code}
                    </span>
                    <Badge status={plan.status} />
                  </div>

                  {/* Plan Title & Description */}
                  <div>
                    <h3 className="text-base font-bold text-zinc-900">{plan.name}</h3>
                    <p className="text-xs text-zinc-500 mt-1 min-h-[36px] line-clamp-2 leading-relaxed">
                      {plan.description}
                    </p>
                  </div>

                  {/* Pricing & Duration */}
                  <div className="p-3 rounded-lg bg-zinc-50 border border-zinc-100 flex items-baseline justify-between">
                    <div>
                      <div className="text-xl font-bold font-mono text-zinc-900 tabular-nums">
                        TSh {plan.price.toLocaleString()}
                      </div>
                      <div className="text-[10px] text-zinc-400 font-mono uppercase">
                        {plan.currency} / {plan.duration_days} Days
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="text-[10px] text-zinc-500 block">Active Subscriptions</span>
                      <span className="font-mono font-bold text-xs text-zinc-800">
                        {plan.active_subscriptions_count}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Plan Card Actions */}
                <div className="pt-4 mt-4 border-t border-zinc-100 flex items-center justify-between gap-2">
                  <button
                    onClick={() => handleOpenPriceModal(plan)}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-200 bg-white hover:bg-zinc-50 text-xs font-medium text-zinc-700 transition-colors shadow-2xs"
                  >
                    <Edit2 className="h-3.5 w-3.5 text-zinc-400" />
                    <span>Change Price</span>
                  </button>

                  <button
                    onClick={() => setStatusModalPlan(plan)}
                    className="p-1.5 rounded-lg border border-zinc-200 hover:bg-zinc-100 text-zinc-600 transition-colors"
                    title={plan.status === 'ACTIVE' ? 'Deactivate Plan' : 'Activate Plan'}
                  >
                    {plan.status === 'ACTIVE' ? (
                      <ToggleRight className="h-4 w-4 text-emerald-600" />
                    ) : (
                      <ToggleLeft className="h-4 w-4 text-zinc-400" />
                    )}
                  </button>

                  <button
                    onClick={() => setDeleteModalPlan(plan)}
                    className="p-1.5 rounded-lg border border-zinc-200 hover:bg-rose-50 text-zinc-400 hover:text-rose-600 transition-colors"
                    title="Delete Plan"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Edit Price Modal */}
        <Modal
          isOpen={!!priceModalPlan}
          onClose={() => setPriceModalPlan(null)}
          title={`Update Price: ${priceModalPlan?.name}`}
          description="Adjust the plan's authoritative purchase price in Tanzanian Shillings (TZS)."
        >
          <form onSubmit={handleUpdatePrice} className="space-y-4">
            {priceError && (
              <div className="p-3 text-xs rounded-md bg-rose-50 border border-rose-200 text-rose-700 font-medium">
                {priceError}
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-zinc-700 mb-1">
                New Price (TZS) <span className="text-rose-500">*</span>
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-mono font-medium text-zinc-400">
                  TSh
                </span>
                <input
                  type="number"
                  min="0"
                  step="500"
                  value={newPrice}
                  onChange={(e) => setNewPrice(Number(e.target.value))}
                  disabled={priceSubmitting}
                  className="w-full pl-12 pr-3 py-2 text-sm font-mono bg-white border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                  required
                />
              </div>
              <p className="text-[11px] text-zinc-500 mt-1.5 leading-relaxed">
                Current price: <strong className="font-mono">TSh {priceModalPlan?.price.toLocaleString()}</strong>.
                New purchases will be billed at the updated amount. Existing subscriptions are unchanged.
              </p>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-zinc-100">
              <button
                type="button"
                onClick={() => setPriceModalPlan(null)}
                disabled={priceSubmitting}
                className="px-3.5 py-2 text-xs font-medium text-zinc-600 hover:text-zinc-800 hover:bg-zinc-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={priceSubmitting || newPrice < 0}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-all shadow-sm disabled:opacity-50"
              >
                {priceSubmitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <span>Save New Price</span>
              </button>
            </div>
          </form>
        </Modal>

        {/* Change Status Confirmation Modal */}
        <ConfirmDialog
          isOpen={!!statusModalPlan}
          onClose={() => setStatusModalPlan(null)}
          onConfirm={handleToggleStatus}
          title={`${statusModalPlan?.status === 'ACTIVE' ? 'Deactivate' : 'Activate'} Plan: ${statusModalPlan?.name}`}
          description={
            statusModalPlan?.status === 'ACTIVE'
              ? `Deactivating "${statusModalPlan?.name}" will remove it from the customer checkout catalog. Existing subscriptions on this plan will continue uninterrupted until their natural expiry.`
              : `Activating "${statusModalPlan?.name}" will make it immediately visible to customers on their purchase and renewal screen.`
          }
          confirmLabel={statusModalPlan?.status === 'ACTIVE' ? 'Deactivate Plan' : 'Activate Plan'}
          severity={statusModalPlan?.status === 'ACTIVE' ? 'warning' : 'info'}
          requireReason={false}
        />

        {/* Delete Plan Confirmation Modal */}
        <ConfirmDialog
          isOpen={!!deleteModalPlan}
          onClose={() => setDeleteModalPlan(null)}
          onConfirm={handleDeletePlan}
          title={`Delete Plan: ${deleteModalPlan?.name}`}
          description={`Are you sure you want to permanently delete plan "${deleteModalPlan?.name}"? If there are any active customer subscriptions associated with this plan, the deletion will be rejected.`}
          confirmLabel="Delete Plan"
          severity="danger"
          requireReason={false}
        />
      </div>
    </AdminLayout>
  );
}
