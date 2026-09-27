import React from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  Radio,
  Slash,
  Sparkles,
  HelpCircle,
} from 'lucide-react';

export type BadgeVariant =
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'DEACTIVATED'
  | 'CONNECTED'
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'ERROR'
  | 'STOPPED'
  | 'SUCCESS'
  | 'PENDING'
  | 'FAILED'
  | 'EXPIRING_SOON'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'MANUALLY_GRANTED'
  | 'INACTIVE'
  | 'DEFAULT';

interface BadgeProps {
  status: string;
  label?: string;
  size?: 'sm' | 'md';
  pulse?: boolean;
}

export const Badge: React.FC<BadgeProps> = ({ status, label, size = 'sm', pulse = false }) => {
  const norm = (status || '').toUpperCase() as BadgeVariant;
  const displayLabel = label || status.replace(/_/g, ' ');

  let styles = 'bg-zinc-100 text-zinc-700 border-zinc-200';
  let Icon = HelpCircle;

  switch (norm) {
    case 'ACTIVE':
    case 'SUCCESS':
    case 'CONNECTED':
      styles = 'bg-emerald-50 text-emerald-700 border-emerald-200/80';
      Icon = CheckCircle2;
      break;

    case 'EXPIRING_SOON':
    case 'PENDING':
    case 'CONNECTING':
      styles = 'bg-amber-50 text-amber-700 border-amber-200/80';
      Icon = Clock;
      break;

    case 'SUSPENDED':
      styles = 'bg-orange-50 text-orange-700 border-orange-200/80';
      Icon = AlertTriangle;
      break;

    case 'DEACTIVATED':
    case 'CANCELLED':
    case 'FAILED':
    case 'ERROR':
      styles = 'bg-rose-50 text-rose-700 border-rose-200/80';
      Icon = XCircle;
      break;

    case 'DISCONNECTED':
    case 'STOPPED':
    case 'INACTIVE':
      styles = 'bg-zinc-100 text-zinc-600 border-zinc-200';
      Icon = Slash;
      break;

    case 'MANUALLY_GRANTED':
      styles = 'bg-blue-50 text-blue-700 border-blue-200/80';
      Icon = Sparkles;
      break;

    default:
      styles = 'bg-zinc-100 text-zinc-700 border-zinc-200';
      Icon = Radio;
      break;
  }

  const sizeClasses = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs font-medium';

  return (
    <span
      className={`inline-flex items-center gap-1.5 font-medium rounded-full border ${styles} ${sizeClasses} whitespace-nowrap`}
    >
      <span className="relative flex h-2 w-2 items-center justify-center">
        {pulse && norm === 'CONNECTED' && (
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
        )}
        <Icon className="h-3 w-3 shrink-0" />
      </span>
      <span>{displayLabel}</span>
    </span>
  );
};
