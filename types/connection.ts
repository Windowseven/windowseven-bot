export type WhatsAppConnectionStatus =
  | 'CONNECTED'
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'ERROR'
  | 'STOPPED';

export interface WhatsAppConnection {
  id: string;
  tenant_id: string;
  tenant_name: string;
  customer_phone: string;
  status: WhatsAppConnectionStatus;
  desired_state: 'RUNNING' | 'STOPPED';
  actual_state: string;
  assigned_worker_id: string | null;
  lease_epoch: number;
  last_connected_at: string | null;
  last_activity_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConnectionFilter {
  search?: string;
  status?: WhatsAppConnectionStatus | 'ALL';
  page?: number;
  limit?: number;
}

export interface ForceDisconnectInput {
  reason: string;
}
