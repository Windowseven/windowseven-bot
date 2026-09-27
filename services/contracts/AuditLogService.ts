import { PlatformAuditLog, AuditLogFilter } from '@/types/auditLog';
import { PaginatedResult } from '@/types/api';

export interface AuditLogService {
  listAuditLogs(filter?: AuditLogFilter): Promise<PaginatedResult<PlatformAuditLog>>;
  getAuditLog(id: string): Promise<PlatformAuditLog | null>;
}
