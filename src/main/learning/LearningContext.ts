import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { LearningTurn } from '../../shared/contracts/learning';
import type { LearningOrigin } from './LearningEvidence';
import { LearningService } from './LearningService';
import { learningError } from './LearningRepository';

export interface LearningDispatch { id: string; text: string; turn?: LearningTurn; blocked?: () => void }

/** Ephemeral provider context only: never rewrites Pi history or signed messages. */
export class LearningContextAdapter {
  private readonly pending = new Map<string, LearningDispatch>();
  private active: { origin: LearningOrigin; dispatch: LearningDispatch; prepared: Awaited<ReturnType<LearningService['prepareDispatch']>> | undefined } | null = null;
  private disposed = false;
  private readonly initialOrigin: LearningOrigin;
  constructor(private readonly service: LearningService, private readonly origin: () => LearningOrigin) { this.initialOrigin = origin(); }
  register(dispatch: LearningDispatch): void {
    if (this.pending.size >= 100 && !this.pending.has(dispatch.id)) learningError('Pending learning dispatch limit reached.');
    this.pending.set(dispatch.id, dispatch);
  }
  cancel(id: string): void { this.pending.delete(id); }
  settle(): void { this.active = null; }
  start(text: string, queued?: LearningDispatch): void {
    const dispatch = queued ?? [...this.pending.values()].find((item) => item.text === text);
    if (dispatch) this.pending.delete(dispatch.id);
    this.active = dispatch ? { origin: this.origin(), dispatch, prepared: undefined } : null;
  }
  wrap(original: AgentSession['agent']['streamFunction']): AgentSession['agent']['streamFunction'] {
    return async (model, context, options) => {
      const active = this.active;
      if (!active || this.disposed) return original(model, context, options);
      const origin = active.origin;
      const pinned = Boolean(active.dispatch.turn?.pins.length);
      if (!this.service.active(origin) && !pinned) return original(model, context, options);
      if (active.prepared === undefined) {
        try { active.prepared = await this.service.prepareDispatch(origin, active.dispatch.id, active.dispatch.text, active.dispatch.turn); }
        catch (error) { active.dispatch.blocked?.(); delete active.dispatch.blocked; throw error; }
      }
      const prepared = active.prepared;
      if (!prepared) return original(model, context, options);
      if (!origin.valid() || this.disposed || options?.signal?.aborted) {
        await this.service.markDispatch(origin, active.dispatch.id, 'not-sent');
        if (pinned) learningError('Originating session changed before dispatch.');
        active.prepared = null;
        return original(model, context, options);
      }
      if (!this.service.active(origin) && prepared.manifest.state === 'prepared') {
        await this.service.markDispatch(origin, active.dispatch.id, 'not-sent');
        if (active.dispatch.turn?.pins.length) learningError('Learning was switched off. Refresh the explicit selection.');
        active.prepared = null;
        return original(model, context, options);
      }
      // A retry/tool-loop request reuses the same ephemeral block, not another attachment.
      const augmented = prepared.block ? { ...context, messages: [...context.messages, { role: 'user' as const, content: prepared.block, timestamp: prepared.manifest.createdAt }] } : context;
      try {
        const stream = await original(model, augmented, options);
        if (prepared.manifest.state === 'prepared') {
          prepared.manifest.state = 'handed-to-runtime';
          await this.service.markDispatch(origin, active.dispatch.id, 'handed-to-runtime');
        }
        return stream;
      } catch (error) {
        if (prepared.manifest.state === 'prepared') void this.service.markDispatch(origin, active.dispatch.id, 'uncertain');
        throw error;
      }
    };
  }
  dispose(): void { this.disposed = true; this.pending.clear(); this.service.invalidate(this.initialOrigin); this.active = null; }
}
