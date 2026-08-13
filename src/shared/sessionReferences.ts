export const SESSION_REFERENCE_TRANSFER_TYPE = 'application/x-fate-session-reference';

export interface SessionReferenceAttachment {
  id: string;
  title: string;
  projectPath: string;
}

export type DraggedSessionReference = SessionReferenceAttachment;

interface TransferReader {
  getData(type: string): string;
}

function boundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximum ? normalized : null;
}

export function serializeSessionReference(reference: DraggedSessionReference): string {
  return JSON.stringify({
    id: reference.id,
    title: reference.title,
    projectPath: reference.projectPath,
  });
}

export function readSessionReference(transfer: TransferReader | null | undefined): DraggedSessionReference | null {
  if (!transfer) return null;
  try {
    const value: unknown = JSON.parse(transfer.getData(SESSION_REFERENCE_TRANSFER_TYPE));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const id = boundedText(record.id, 500);
    const title = boundedText(record.title, 200);
    const projectPath = boundedText(record.projectPath, 32_768);
    return id && title && projectPath ? { id, title, projectPath } : null;
  } catch {
    return null;
  }
}
