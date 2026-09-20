import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type * as vscode from 'vscode';

const HEARTBEAT_MS = 15_000;

interface RuntimeState {
  readonly version: 2;
  readonly instanceId: string;
  readonly supervisorPid: number;
  readonly controlOrigin: string;
  readonly controlToken: string;
  readonly runtime: {
    readonly state: 'starting' | 'ready' | 'stopped';
    readonly origin: string;
    readonly runtimeId?: string;
    readonly clientModule?: string;
    readonly pid?: number;
    readonly startedAt?: string;
  };
}

/** Lifecycle-only connection to the independently owned development runtime supervisor. */
export class RuntimeControl implements vscode.Disposable {
  private readonly clientId = randomUUID();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private disposed = false;

  private constructor(private readonly state: RuntimeState) {}

  /** Discovers the development supervisor next to the multi-repository workspace. */
  static async discover(extensionUri: vscode.Uri): Promise<RuntimeControl | undefined> {
    return RuntimeControl.fromStateFile(developmentRuntimePath(extensionUri));
  }

  /** Connects to one supervisor rendezvous file, returning undefined when it is absent. */
  static async fromStateFile(path: string): Promise<RuntimeControl | undefined> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (isFileNotFound(error)) return undefined;
      throw error;
    }
    if (!isRuntimeState(value)) throw new Error('Invalid DSH runtime supervisor state');
    const control = new RuntimeControl(value);
    const status = await control.request('/v1/status');
    if (!isStatus(status) || status.instanceId !== value.instanceId
      || status.origin !== value.runtime.origin || status.state !== 'ready') {
      throw new Error('DSH runtime supervisor is not ready');
    }
    await control.renew();
    control.heartbeat = setInterval(() => {
      void control.renew().catch(() => {
        // DSH transport recovery reports the user-visible loss; this lease expires independently.
      });
    }, HEARTBEAT_MS);
    return control;
  }

  get origin(): string {
    return this.state.runtime.origin;
  }

  get clientModule(): string | undefined {
    return this.state.runtime.clientModule;
  }

  get runtimeId(): string | undefined {
    return this.state.runtime.runtimeId;
  }

  /** Reads the version string published for the supervised DSH backend. */
  async backendVersion(): Promise<string> {
    const value = await this.request('/v1/backend-version', {}, true);
    if (value === undefined) return 'Unavailable';
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('Invalid DSH backend version response');
    }
    return value;
  }

  /** Returns a process-memory launch URL without persisting the launch token in runtime state. */
  async bootstrapUrl(): Promise<string> {
    const value = await this.request('/v1/bootstrap');
    if (!isBootstrap(value)) throw new Error('Invalid DSH runtime bootstrap response');
    const url = new URL(value.launchUrl);
    if (url.origin !== this.origin) throw new Error('DSH runtime bootstrap authority does not match its state');
    return url.href;
  }

  /** Requests complete managed-runtime shutdown. */
  async stop(): Promise<void> {
    await this.request('/v1/stop', { method: 'POST' });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    void this.request(`/v1/clients/${this.clientId}`, { method: 'DELETE' }).catch(() => {
      // A stopped supervisor has already released the lease with its process state.
    });
  }

  private async renew(): Promise<void> {
    if (this.disposed) return;
    const value = await this.request(`/v1/clients/${this.clientId}`, { method: 'PUT' });
    if (!isLease(value)) throw new Error('Invalid DSH runtime lease response');
  }

  private async request(path: string, init: RequestInit = {}, allowNotFound = false): Promise<unknown> {
    const response = await fetch(new URL(path, this.state.controlOrigin), {
      ...init,
      headers: {
        ...init.headers,
        authorization: `Bearer ${this.state.controlToken}`,
      },
    });
    if (allowNotFound && response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(`DSH runtime supervisor request failed with HTTP ${String(response.status)}`);
    }
    if (response.status === 204) return undefined;
    return response.json();
  }
}

function developmentRuntimePath(extensionUri: vscode.Uri): string {
  return resolve(extensionUri.fsPath, '..', '..', '.dev', 'dsh-companion', 'runtime.json');
}

function isRuntimeState(value: unknown): value is RuntimeState {
  if (!isRecord(value) || value.version !== 2 || typeof value.instanceId !== 'string'
    || !Number.isSafeInteger(value.supervisorPid) || typeof value.controlOrigin !== 'string'
    || typeof value.controlToken !== 'string' || !isRecord(value.runtime)
    || !['starting', 'ready', 'stopped'].includes(String(value.runtime.state))
    || typeof value.runtime.origin !== 'string'
    || (value.runtime.runtimeId !== undefined && (typeof value.runtime.runtimeId !== 'string'
      || !/^(?:source|\d+\.\d+\.\d+-linux-x64)$/u.test(value.runtime.runtimeId)))
    || (value.runtime.clientModule !== undefined && typeof value.runtime.clientModule !== 'string')) return false;
  try {
    const control = new URL(value.controlOrigin);
    const runtime = new URL(value.runtime.origin);
    return control.protocol === 'http:' && control.hostname === '127.0.0.1'
      && runtime.protocol === 'http:' && runtime.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function isStatus(value: unknown): value is { instanceId: string; origin: string; state: string } {
  return isRecord(value) && value.version === 1 && typeof value.instanceId === 'string'
    && typeof value.origin === 'string' && typeof value.state === 'string';
}

function isBootstrap(value: unknown): value is { readonly launchUrl: string } {
  return isRecord(value) && value.version === 1 && typeof value.launchUrl === 'string';
}

function isLease(value: unknown): value is { readonly expiresInMs: number } {
  return isRecord(value) && value.version === 1 && Number.isSafeInteger(value.expiresInMs)
    && Number(value.expiresInMs) > HEARTBEAT_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
