'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Users,
  Layers,
  CreditCard,
  Receipt,
  Radio,
  FileText,
  Bot,
  ShieldCheck,
  ExternalLink,
} from 'lucide-react';

interface SidebarProps {
  isOpen?: boolean;
  onClose?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ isOpen = false, onClose }) => {
  const pathname = usePathname();

  const navItems = [
    { href: '/admin', label: 'Overview', icon: LayoutDashboard },
    { href: '/admin/customers', label: 'Customers', icon: Users },
    { href: '/admin/plans', label: 'Plans & Pricing', icon: Layers },
    { href: '/admin/subscriptions', label: 'Subscriptions', icon: CreditCard },
    { href: '/admin/payments', label: 'Payments', icon: Receipt },
    { href: '/admin/connections', label: 'WhatsApp Connections', icon: Radio },
    { href: '/admin/audit-logs', label: 'Audit Logs', icon: FileText },
  ];

  const content = (
    <div className="flex flex-col h-full bg-zinc-900 text-zinc-300 w-64 border-r border-zinc-800">
      {/* Brand Header */}
      <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
        <Link href="/admin" className="flex items-center gap-2.5 group">
          <div className="h-8 w-8 rounded-lg bg-brand-600 flex items-center justify-center text-white shadow-sm group-hover:bg-brand-500 transition-colors">
            <Bot className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-bold text-white tracking-tight flex items-center gap-1.5">
              Windowseven
            </div>
            <div className="text-[10px] text-zinc-400 font-mono tracking-wider uppercase">
              Control Plane
            </div>
          </div>
        </Link>
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-400">
          v1.0
        </span>
      </div>

      {/* Environment Badge */}
      <div className="px-4 py-3 border-b border-zinc-800/80 bg-zinc-950/40">
        <div className="flex items-center justify-between text-xs">
          <span className="flex items-center gap-1.5 text-zinc-400 font-medium">
            <span className="h-2 w-2 rounded-full bg-emerald-400 inline-block animate-pulse" />
            Mock Service Mode
          </span>
          <span className="text-[11px] font-mono text-zinc-500">Node v24</span>
        </div>
      </div>

      {/* Main Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        <div className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          Platform Administration
        </div>
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href || (item.href !== '/admin' && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onClose}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                isActive
                  ? 'bg-zinc-800 text-white font-semibold shadow-2xs'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
              }`}
            >
              <Icon className={`h-4 w-4 shrink-0 ${isActive ? 'text-brand-400' : 'text-zinc-400'}`} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Admin User Footer */}
      <div className="p-3 border-t border-zinc-800 bg-zinc-950/40">
        <div className="flex items-center gap-3 p-2 rounded-lg bg-zinc-800/60 border border-zinc-700/50">
          <div className="h-8 w-8 rounded-full bg-zinc-700 flex items-center justify-center text-zinc-300 text-xs font-bold">
            SA
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold text-white truncate flex items-center gap-1">
              Super Admin
              <ShieldCheck className="h-3.5 w-3.5 text-brand-400 shrink-0" />
            </div>
            <div className="text-[10px] text-zinc-400 font-mono truncate">
              admin@windowseven.io
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex flex-col shrink-0 h-screen sticky top-0">{content}</aside>

      {/* Mobile Drawer */}
      {isOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div className="fixed inset-0 bg-zinc-950/70 backdrop-blur-xs" onClick={onClose} />
          <div className="relative flex flex-col z-10 animate-in slide-in-from-left duration-200">
            {content}
          </div>
        </div>
      )}
    </>
  );
};
