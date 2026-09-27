'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { Menu, RefreshCw, Bell, Shield } from 'lucide-react';

interface HeaderProps {
  onOpenMobileNav: () => void;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  onOpenMobileNav,
  onRefresh,
  isRefreshing = false,
}) => {
  const pathname = usePathname();

  const getBreadcrumbTitle = () => {
    if (pathname === '/admin') return 'Platform Overview';
    if (pathname.startsWith('/admin/customers')) return 'Customer Management';
    if (pathname.startsWith('/admin/plans')) return 'Plans & Pricing';
    if (pathname.startsWith('/admin/subscriptions')) return 'Customer Subscriptions';
    if (pathname.startsWith('/admin/payments')) return 'Payment Transactions';
    if (pathname.startsWith('/admin/connections')) return 'WhatsApp Connections';
    if (pathname.startsWith('/admin/audit-logs')) return 'Platform Audit Logs';
    return 'Admin Control Center';
  };

  return (
    <header className="sticky top-0 z-30 flex items-center justify-between h-14 px-4 sm:px-6 bg-white border-b border-zinc-200">
      <div className="flex items-center gap-3">
        <button
          onClick={onOpenMobileNav}
          className="lg:hidden p-1.5 rounded-lg text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100 transition-colors"
          aria-label="Open navigation menu"
        >
          <Menu className="h-5 w-5" />
        </button>

        <div className="flex items-center gap-2 text-xs">
          <span className="text-zinc-400 font-medium hidden sm:inline">Admin</span>
          <span className="text-zinc-300 hidden sm:inline">/</span>
          <h1 className="font-semibold text-zinc-900 text-sm">{getBreadcrumbTitle()}</h1>
        </div>
      </div>

      <div className="flex items-center gap-2.5">
        <div className="hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-100 border border-zinc-200 text-[11px] font-medium text-zinc-600">
          <Shield className="h-3 w-3 text-emerald-600" />
          <span>SUPER_ADMIN Authorization</span>
        </div>

        {onRefresh && (
          <button
            onClick={onRefresh}
            disabled={isRefreshing}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100 transition-colors border border-transparent hover:border-zinc-200 disabled:opacity-50"
            title="Refresh current dataset"
            aria-label="Refresh data"
          >
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin text-brand-600' : ''}`} />
          </button>
        )}
      </div>
    </header>
  );
};
