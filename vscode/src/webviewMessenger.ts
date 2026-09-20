const MAX_BATCH_MESSAGES = 64;

/** Minimal VS Code Webview posting face used by the ordered message pump. */
export interface WebviewMessageTarget {
  /** Posts one structured-cloneable message and reports whether the Webview accepted it. */
  postMessage(message: unknown): Thenable<boolean>;
}

/** Buffers host messages until the Webview is ready and posts bounded batches in order. */
export class WebviewMessenger {
  private readonly queue: object[] = [];
  private ready = false;
  private disposed = false;
  private pump: Promise<void> | undefined;

  constructor(
    private readonly target: WebviewMessageTarget,
    private readonly onFailure: (error: unknown) => void,
  ) {}

  /** Enqueues one host-to-Webview message without allowing concurrent posts. */
  send(message: object): void {
    if (this.disposed) return;
    this.queue.push(message);
    this.schedulePump();
  }

  /** Releases buffered messages after the Webview has installed its receive listener. */
  markReady(): void {
    if (this.disposed || this.ready) return;
    this.ready = true;
    this.schedulePump();
  }

  /** Waits until all currently queued messages have settled. */
  async flush(): Promise<void> {
    while (this.pump !== undefined) await this.pump;
  }

  /** Stops delivery and releases messages owned by a disposed editor panel. */
  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
  }

  private schedulePump(): void {
    if (!this.ready || this.disposed || this.pump !== undefined || this.queue.length === 0) return;
    const running = this.deliver().catch((error: unknown) => {
      this.queue.length = 0;
      if (!this.disposed) this.onFailure(error);
    }).finally(() => {
      if (this.pump === running) this.pump = undefined;
      this.schedulePump();
    });
    this.pump = running;
  }

  private async deliver(): Promise<void> {
    while (this.ready && !this.disposed && this.queue.length > 0) {
      const messages = this.queue.splice(0, MAX_BATCH_MESSAGES);
      const accepted = await this.target.postMessage({ type: 'batch', messages });
      if (!accepted && !this.disposed) throw new Error('DSH Companion Webview rejected a message batch');
    }
  }
}
