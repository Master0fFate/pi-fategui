import type { BrowserAnnotation } from '../../shared/contracts/browser';
import { BROWSER_MAX_ANNOTATIONS, browserAnnotationSchema } from '../../shared/contracts/browser';

const MAX_STORED_ANNOTATIONS = 500;

export class BrowserAnnotationRepository {
  private readonly annotations = new Map<string, BrowserAnnotation>();

  save(input: BrowserAnnotation): BrowserAnnotation {
    const annotation = browserAnnotationSchema.parse(input);
    this.annotations.delete(annotation.id);
    this.annotations.set(annotation.id, annotation);
    while (this.annotations.size > MAX_STORED_ANNOTATIONS) {
      const oldest = this.annotations.keys().next().value as string | undefined;
      if (!oldest) break;
      this.annotations.delete(oldest);
    }
    return structuredClone(annotation);
  }

  get(id: string): BrowserAnnotation | null {
    const annotation = this.annotations.get(id);
    return annotation ? structuredClone(annotation) : null;
  }

  findElement(tabId: string, documentEpoch: number, backendNodeId: number): BrowserAnnotation | null {
    const annotation = [...this.annotations.values()].find((candidate) => (
      candidate.kind === 'element'
      && candidate.tabId === tabId
      && candidate.documentEpoch === documentEpoch
      && candidate.target.backendNodeId === backendNodeId
    ));
    return annotation ? structuredClone(annotation) : null;
  }

  list(tabId?: string): BrowserAnnotation[] {
    return [...this.annotations.values()]
      .filter((annotation) => !tabId || annotation.tabId === tabId)
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((annotation) => structuredClone(annotation));
  }

  updateComment(id: string, comment: string): BrowserAnnotation | null {
    const current = this.annotations.get(id);
    if (!current) return null;
    const updated = browserAnnotationSchema.parse({ ...current, comment });
    this.annotations.set(id, updated);
    return structuredClone(updated);
  }

  remove(id: string): boolean {
    return this.annotations.delete(id);
  }

  resolve(ids: readonly string[]): BrowserAnnotation[] {
    return [...new Set(ids)]
      .slice(0, BROWSER_MAX_ANNOTATIONS)
      .flatMap((id) => {
        const annotation = this.annotations.get(id);
        return annotation ? [structuredClone(annotation)] : [];
      });
  }

}
