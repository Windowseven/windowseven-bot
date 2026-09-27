'use client';

import React, { ReactNode } from 'react';
import { ToastProvider } from '@/components/common/Toast';

export default function AdminRootLayout({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}
