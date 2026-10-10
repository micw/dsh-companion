export type TabStatus = 'running' | 'finished' | 'seen' | 'error';

/** Projects the latest DSH Turn completion and a locally acknowledged presentation watermark. */
export class TabStatusProjection {
  private running = false;
  private latestEnd = 0;
  private failed = false;

  constructor(private seenThrough: number = 0) {}

  setRunning(running: boolean): void {
    this.running = running;
  }

  end(time: number, reason: string): void {
    if (!Number.isSafeInteger(time) || time <= 0 || time < this.latestEnd) return;
    this.latestEnd = time;
    this.failed = reason === 'error';
  }

  acknowledge(): number | undefined {
    if (this.running || this.latestEnd <= this.seenThrough) return undefined;
    this.seenThrough = this.latestEnd;
    return this.seenThrough;
  }

  get status(): TabStatus {
    if (this.running) return 'running';
    if (this.latestEnd <= this.seenThrough) return 'seen';
    return this.failed ? 'error' : 'finished';
  }
}
