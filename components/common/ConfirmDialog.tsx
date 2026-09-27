'use client';

import React, { useState } from 'react';
import { Modal } from './Modal';
import { AlertTriangle, AlertOctagon, Info, Loader2 } from 'lucide-react';

interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (reason: string, confirmationText?: string) => Promise<void>;
  title: string;
  description: string;
  confirmLabel?: string;
  severity?: 'danger' | 'warning' | 'info';
  requireReason?: boolean;
  reasonPlaceholder?: string;
  requiredConfirmationText?: string; // If provided, user must type this exact text to confirm (e.g. customer name)
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Confirm Action',
  severity = 'warning',
  requireReason = true,
  reasonPlaceholder = 'Provide a specific operational or business reason for this action...',
  requiredConfirmationText,
}) => {
  const [reason, setReason] = useState('');
  const [typedConfirmation, setTypedConfirmation] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setReason('');
    setTypedConfirmation('');
    setError(null);
    setLoading(false);
  };

  const handleClose = () => {
    if (loading) return;
    reset();
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (requireReason && !reason.trim()) {
      setError('A mandatory reason is required to perform this administrative action.');
      return;
    }
    if (requiredConfirmationText && typedConfirmation.trim() !== requiredConfirmationText.trim()) {
      setError(`Please type "${requiredConfirmationText}" exactly to confirm.`);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      await onConfirm(reason.trim(), typedConfirmation.trim());
      reset();
      onClose();
    } catch (err: unknown) {
      const errObj = err as { message?: string };
      setError(errObj.message || 'An error occurred while executing the mutation.');
    } finally {
      setLoading(false);
    }
  };

  const isDanger = severity === 'danger';
  const Icon = isDanger ? AlertOctagon : severity === 'warning' ? AlertTriangle : Info;
  const iconColor = isDanger ? 'text-rose-600 bg-rose-50' : severity === 'warning' ? 'text-amber-600 bg-amber-50' : 'text-blue-600 bg-blue-50';

  const buttonClass = isDanger
    ? 'bg-rose-600 hover:bg-rose-700 text-white'
    : severity === 'warning'
    ? 'bg-amber-600 hover:bg-amber-700 text-white'
    : 'bg-brand-600 hover:bg-brand-700 text-white';

  const isConfirmDisabled =
    loading ||
    (requireReason && !reason.trim()) ||
    (requiredConfirmationText ? typedConfirmation.trim() !== requiredConfirmationText.trim() : false);

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={title}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="flex items-start gap-3 p-3 rounded-lg bg-zinc-50 border border-zinc-100">
          <div className={`p-2 rounded-full shrink-0 ${iconColor}`}>
            <Icon className="h-5 w-5" />
          </div>
          <p className="text-xs text-zinc-600 leading-relaxed pt-1">{description}</p>
        </div>

        {error && (
          <div className="p-3 text-xs rounded-md bg-rose-50 border border-rose-200 text-rose-700 font-medium">
            {error}
          </div>
        )}

        {requireReason && (
          <div>
            <label className="block text-xs font-semibold text-zinc-700 mb-1">
              Administrative Reason <span className="text-rose-500">*</span>
            </label>
            <textarea
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={reasonPlaceholder}
              disabled={loading}
              className="w-full text-xs p-2.5 rounded-lg border border-zinc-300 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 transition-shadow disabled:bg-zinc-50"
            />
            <p className="text-[11px] text-zinc-400 mt-1">
              This reason will be recorded immutably in the platform audit log for forensic auditing.
            </p>
          </div>
        )}

        {requiredConfirmationText && (
          <div className="p-3 rounded-lg border border-rose-200 bg-rose-50/50 space-y-2">
            <label className="block text-xs font-semibold text-rose-900">
              Terminal Verification Step
            </label>
            <p className="text-[11px] text-rose-700">
              Type <strong className="font-mono font-bold select-all">{requiredConfirmationText}</strong> below to confirm:
            </p>
            <input
              type="text"
              value={typedConfirmation}
              onChange={(e) => setTypedConfirmation(e.target.value)}
              disabled={loading}
              placeholder={requiredConfirmationText}
              className="w-full text-xs p-2 rounded-md border border-rose-300 bg-white focus:outline-none focus:ring-2 focus:ring-rose-500 font-mono"
            />
          </div>
        )}

        <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-zinc-100">
          <button
            type="button"
            onClick={handleClose}
            disabled={loading}
            className="px-3.5 py-2 text-xs font-medium text-zinc-600 hover:text-zinc-800 hover:bg-zinc-100 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isConfirmDisabled}
            className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg transition-all shadow-sm disabled:opacity-50 disabled:cursor-not-allowed ${buttonClass}`}
          >
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            <span>{confirmLabel}</span>
          </button>
        </div>
      </form>
    </Modal>
  );
};
