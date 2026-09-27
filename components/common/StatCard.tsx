import React from 'react';
import { LucideIcon } from 'lucide-react';

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: LucideIcon;
  badge?: {
    label: string;
    variant: 'positive' | 'warning' | 'danger' | 'neutral';
  };
  onClick?: () => void;
}

export const StatCard: React.FC<StatCardProps> = ({
  title,
  value,
  subtitle,
  icon: Icon,
  badge,
  onClick,
}) => {
  const badgeStyles = {
    positive: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    warning: 'bg-amber-50 text-amber-700 border-amber-200',
    danger: 'bg-rose-50 text-rose-700 border-rose-200',
    neutral: 'bg-zinc-100 text-zinc-600 border-zinc-200',
  }[badge?.variant || 'neutral'];

  return (
    <div
      onClick={onClick}
      className={`p-5 rounded-xl bg-white border border-zinc-200/90 shadow-xs hover:border-zinc-300 transition-all ${
        onClick ? 'cursor-pointer' : ''
      }`}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">{title}</span>
        <div className="h-8 w-8 rounded-lg bg-zinc-50 border border-zinc-100 flex items-center justify-center text-zinc-600">
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <div className="flex items-baseline justify-between">
        <div className="text-2xl font-bold tracking-tight text-zinc-900 font-mono tabular-nums">
          {value}
        </div>
        {badge && (
          <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full border ${badgeStyles}`}>
            {badge.label}
          </span>
        )}
      </div>
      {subtitle && <p className="text-xs text-zinc-400 mt-2">{subtitle}</p>}
    </div>
  );
};
