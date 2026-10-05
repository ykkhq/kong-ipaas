import type { FlowStatus } from '../api';

const LABEL: Record<FlowStatus, string> = { draft: 'Draft', deploying: 'Deploying', live: 'Live', outdated: 'Live (outdated)', error: 'Error' };

export function StatusBadge({ status, title }: { status: FlowStatus; title?: string }) {
  return <span className={`badge ${status}`} title={title}>{LABEL[status] ?? status}</span>;
}
