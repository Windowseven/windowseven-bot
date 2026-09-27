import React, { ReactNode } from 'react';
import { SearchX, Inbox } from 'lucide-react';

interface EmptyStateProps {
  title: string;
  description: string;
  isFiltered?: boolean;
  action?: ReactNode;
  onClearFilters?: () => void;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  title,
  description,
  isFiltered = false,
  action,
  onClearFilters,
}) => {
  const Icon = isFiltered ? SearchX : Inbox;

  return (
    <div className="flex flex-col items-center justify-center p-12 text-center border border-dashed border-zinc-300 rounded-xl bg-white/50 my-4">
      <div className="h-12 w-12 rounded-full bg-zinc-100 flex items-center justify-center text-zinc-400 mb-3.5">
        <Icon className="h-6 w-6 stroke-[1.5]" />
      </div>
      <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
      <p className="text-xs text-zinc-500 max-w-sm mt-1 leading-relaxed">{description}</p>
      {isFiltered && onClearFilters && (
        <button
          onClick={onClearFilters}
          className="mt-4 inline-flex items-center text-xs font-medium text-brand-600 hover:text-brand-700 bg-brand-50 hover:bg-brand-100 px-3 py-1.5 rounded-md transition-colors"
        >
          Clear active filters
        </button>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
};
