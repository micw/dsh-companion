export type RuntimePhase = 'checking' | 'installing' | 'stopping' | 'starting' | 'waiting';

export const runtimePhaseText: Record<RuntimePhase, string> = {
  checking: 'Checking DSH runtime…',
  installing: 'Installing DSH runtime…',
  stopping: 'Stopping previous DSH runtime…',
  starting: 'Starting DSH runtime…',
  waiting: 'Waiting for DSH runtime…',
};

/** Replays the current startup phase to subscribers that arrive after activation began. */
export class RuntimeProgress {
  private phase: RuntimePhase = 'checking';
  private readonly listeners = new Set<(phase: RuntimePhase) => void>();

  get current(): RuntimePhase { return this.phase; }

  subscribe(listener: (phase: RuntimePhase) => void): () => void {
    this.listeners.add(listener);
    listener(this.phase);
    return () => { this.listeners.delete(listener); };
  }

  report(phase: RuntimePhase): void {
    this.phase = phase;
    for (const listener of this.listeners) listener(phase);
  }
}
