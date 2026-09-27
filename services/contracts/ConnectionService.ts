import { WhatsAppConnection, ConnectionFilter, ForceDisconnectInput } from '@/types/connection';
import { PaginatedResult, MutationResult } from '@/types/api';

export interface ConnectionService {
  listConnections(filter?: ConnectionFilter): Promise<PaginatedResult<WhatsAppConnection>>;
  getConnection(id: string): Promise<WhatsAppConnection | null>;
  forceDisconnect(id: string, input: ForceDisconnectInput): Promise<MutationResult<WhatsAppConnection>>;
}
