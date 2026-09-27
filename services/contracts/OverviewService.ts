import { OverviewMetrics } from '@/types/overview';

export interface OverviewService {
  getOverviewMetrics(): Promise<OverviewMetrics>;
}
