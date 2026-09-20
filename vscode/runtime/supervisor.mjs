#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATE_VERSION = 2;
const CONTROL_VERSION = 1;
const CLIENT_LEASE_MS = 45_000;
const LEASE_SWEEP_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const LAUNCH_URL_PATTERN = /dsh web:\s+(http:\/\/[^\s]+\/?\?token=[A-Za-z0-9_-]+)/u;
const LAUNCH_TOKEN_PATTERN = /([?&]token=)[A-Za-z0-9_-]+/gu;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

/** Supervises exactly one DSH runtime and exposes a private lifecycle-only control endpoint. */
export class RuntimeSupervisor {
  #config;
  #instanceId = randomUUID();
  #controlToken = randomBytes(32).toString('base64url');
  #server;
  #controlOrigin;
  #runtime;
  #runtimeReady = false;
  #runtimeStartedAt;
  #bootstrapUrl;
  #clients = new Map();
  #leaseSweep;
  #startupTimer;
  #stopping;
  #resolveStopped;
  #stopped = new Promise((resolveStopped) => { this.#resolveStopped = resolveStopped; });
  #output = '';

  constructor(config) {
    this.#config = parseConfig(config);
  }

  /** Starts the private control endpoint and the configured DSH child. */
  async start() {
    if (this.#server !== undefined) throw new Error('Runtime supervisor is already started');
    await mkdir(dirname(this.#config.stateFile), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.#config.stateFile), 0o700);
    this.#server = createServer((request, response) => {
      void this.#handleRequest(request, response).catch((error) => {
        response.statusCode = 500;
        response.setHeader('content-type', 'application/json');
        response.end(`${JSON.stringify({ error: safeMessage(error) })}\n`);
      });
    });
    await new Promise((resolveListen, rejectListen) => {
      this.#server.once('error', rejectListen);
      this.#server.listen(0, '127.0.0.1', () => {
        this.#server?.off('error', rejectListen);
        resolveListen();
      });
    });
    const address = this.#server.address();
    if (address === null || typeof address === 'string') throw new Error('Supervisor control server has no TCP address');
    this.#controlOrigin = `http://127.0.0.1:${String(address.port)}`;
    this.#leaseSweep = setInterval(() => { this.#expireClients(); }, LEASE_SWEEP_MS);
    this.#leaseSweep.unref();
    await this.#publishState();
    await this.#startRuntime();
  }

  /** Resolves after the supervisor and its DSH child have stopped. */
  wait() {
    return this.#stopped;
  }

  /** Stops the DSH process tree, control endpoint, and owned rendezvous. */
  stop(reason = 'requested') {
    if (this.#stopping !== undefined) return this.#stopping;
    this.#stopping = this.#doStop(reason);
    return this.#stopping;
  }

  snapshot() {
    return {
      version: CONTROL_VERSION,
      instanceId: this.#instanceId,
      state: this.#runtimeReady ? 'ready' : this.#runtime === undefined ? 'stopped' : 'starting',
      origin: this.#config.origin,
      runtimePid: this.#runtime?.pid,
      runtimeStartedAt: this.#runtimeStartedAt,
      clients: this.#clients.size,
      idleShutdown: 'awaiting-dsh-quiescence',
    };
  }

  async #startRuntime() {
    const fileEnvironment = await readEnvironmentFile(this.#config.environmentFile);
    const child = spawn(this.#config.command, this.#config.args, {
      cwd: this.#config.cwd,
      detached: process.platform !== 'win32',
      env: { ...process.env, ...this.#config.environment, ...fileEnvironment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.#runtime = child;
    this.#runtimeStartedAt = new Date().toISOString();
    this.#startupTimer = setTimeout(() => {
      void this.stop(`DSH did not become ready within ${String(this.#config.startupTimeoutMs)}ms`);
    }, this.#config.startupTimeoutMs);
    const outputBuffers = new Map();
    const consume = (chunk) => {
      const text = String(chunk);
      this.#output = (this.#output + text).slice(-16_384);
      if (this.#runtimeReady) return;
      const match = LAUNCH_URL_PATTERN.exec(stripAnsi(this.#output));
      if (match?.[1] === undefined) return;
      const launchUrl = new URL(match[1]);
      if (launchUrl.origin !== this.#config.origin) {
        void this.stop(`DSH announced unexpected origin ${launchUrl.origin}`);
        return;
      }
      this.#bootstrapUrl = launchUrl.href;
      this.#runtimeReady = true;
      if (this.#startupTimer !== undefined) clearTimeout(this.#startupTimer);
      this.#startupTimer = undefined;
      void this.#publishState();
      console.log('DSH Companion runtime ready');
    };
    const relay = (stream) => (chunk) => {
      const text = String(chunk);
      consume(text);
      const buffered = (outputBuffers.get(stream) ?? '') + text;
      const lines = buffered.split(/(?<=\n)/u);
      outputBuffers.set(stream, lines.at(-1)?.endsWith('\n') === false ? lines.pop() : '');
      for (const line of lines) process.stdout.write(redactLaunchTokens(line));
    };
    child.stdout?.on('data', relay('stdout'));
    child.stderr?.on('data', relay('stderr'));
    child.once('error', (error) => { void this.stop(`DSH failed to start: ${safeMessage(error)}`); });
    child.once('exit', (code, signal) => {
      for (const buffered of outputBuffers.values()) {
        if (buffered !== '') process.stdout.write(redactLaunchTokens(buffered));
      }
      if (this.#startupTimer !== undefined) clearTimeout(this.#startupTimer);
      this.#startupTimer = undefined;
      if (this.#runtime === child) this.#runtime = undefined;
      this.#runtimeReady = false;
      this.#bootstrapUrl = undefined;
      void this.#publishState();
      if (this.#stopping === undefined) {
        void this.stop(`DSH exited (${signal ?? String(code)})`);
      }
    });
  }

  async #handleRequest(request, response) {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-type', 'application/json');
    if (!this.#authorized(request.headers.authorization)) {
      response.statusCode = 401;
      response.end('{"error":"unauthorized"}\n');
      return;
    }
    const url = new URL(request.url ?? '/', this.#controlOrigin);
    if (request.method === 'GET' && url.pathname === '/v1/status') {
      response.end(`${JSON.stringify(this.snapshot())}\n`);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/bootstrap') {
      if (this.#bootstrapUrl === undefined) {
        response.statusCode = 409;
        response.end('{"error":"runtime-not-ready"}\n');
      } else {
        response.end(`${JSON.stringify({ version: CONTROL_VERSION, launchUrl: this.#bootstrapUrl })}\n`);
      }
      return;
    }
    const lease = /^\/v1\/clients\/([^/]+)$/u.exec(url.pathname);
    if (lease !== null && CLIENT_ID_PATTERN.test(lease[1] ?? '')) {
      const clientId = lease[1];
      if (request.method === 'PUT') {
        this.#clients.set(clientId, Date.now() + CLIENT_LEASE_MS);
        response.end(`${JSON.stringify({ version: CONTROL_VERSION, expiresInMs: CLIENT_LEASE_MS })}\n`);
        return;
      }
      if (request.method === 'DELETE') {
        this.#clients.delete(clientId);
        response.statusCode = 204;
        response.end();
        return;
      }
    }
    if (request.method === 'POST' && url.pathname === '/v1/stop') {
      response.statusCode = 202;
      response.end('{"accepted":true}\n');
      setImmediate(() => { void this.stop('control request'); });
      return;
    }
    response.statusCode = 404;
    response.end('{"error":"not-found"}\n');
  }

  #authorized(header) {
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const supplied = Buffer.from(header.slice('Bearer '.length));
    const expected = Buffer.from(this.#controlToken);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  #expireClients() {
    const now = Date.now();
    for (const [clientId, expiresAt] of this.#clients) {
      if (expiresAt <= now) this.#clients.delete(clientId);
    }
  }

  async #publishState() {
    if (this.#controlOrigin === undefined) return;
    const state = {
      version: STATE_VERSION,
      instanceId: this.#instanceId,
      supervisorPid: process.pid,
      controlOrigin: this.#controlOrigin,
      controlToken: this.#controlToken,
      runtime: {
        state: this.#runtimeReady ? 'ready' : this.#runtime === undefined ? 'stopped' : 'starting',
        origin: this.#config.origin,
        ...(this.#config.runtimeId === undefined ? {} : { runtimeId: this.#config.runtimeId }),
        ...(this.#config.clientModule === undefined ? {} : { clientModule: this.#config.clientModule }),
        ...(this.#runtime?.pid === undefined ? {} : { pid: this.#runtime.pid }),
        ...(this.#runtimeStartedAt === undefined ? {} : { startedAt: this.#runtimeStartedAt }),
      },
    };
    const temporary = `${this.#config.stateFile}.${this.#instanceId}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.#config.stateFile);
  }

  async #doStop(reason) {
    console.log(`Stopping DSH Companion runtime supervisor: ${reason}`);
    if (this.#leaseSweep !== undefined) clearInterval(this.#leaseSweep);
    this.#leaseSweep = undefined;
    if (this.#startupTimer !== undefined) clearTimeout(this.#startupTimer);
    this.#startupTimer = undefined;
    const runtime = this.#runtime;
    if (runtime?.pid !== undefined) {
      stopProcessTree(runtime.pid);
      await waitForExit(runtime, SHUTDOWN_TIMEOUT_MS);
    }
    this.#runtime = undefined;
    this.#runtimeReady = false;
    this.#bootstrapUrl = undefined;
    const server = this.#server;
    this.#server = undefined;
    if (server !== undefined) await new Promise((resolveClose) => { server.close(() => resolveClose()); });
    await removeOwnState(this.#config.stateFile, this.#instanceId);
    this.#resolveStopped();
  }
}

export function parseConfig(value) {
  if (!isRecord(value) || value.version !== 1 || typeof value.stateFile !== 'string'
    || typeof value.command !== 'string' || !Array.isArray(value.args)
    || value.args.some((item) => typeof item !== 'string') || typeof value.cwd !== 'string'
    || typeof value.origin !== 'string') {
    throw new Error('Invalid DSH Companion runtime supervisor configuration');
  }
  const origin = new URL(value.origin);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.pathname !== '/') {
    throw new Error('DSH Companion runtime origin must be an HTTP IPv4 loopback origin');
  }
  if (value.environment !== undefined && (!isRecord(value.environment)
    || Object.entries(value.environment).some(([name, item]) => !/^[A-Z_][A-Z0-9_]*$/u.test(name)
      || typeof item !== 'string'))) {
    throw new Error('Invalid DSH Companion runtime environment');
  }
  if (value.environmentFile !== undefined && typeof value.environmentFile !== 'string') {
    throw new Error('Invalid DSH Companion runtime environment file');
  }
  if (value.clientModule !== undefined && typeof value.clientModule !== 'string') {
    throw new Error('Invalid DSH Companion runtime Client module');
  }
  if (value.runtimeId !== undefined && (typeof value.runtimeId !== 'string'
    || !/^(?:source|\d+\.\d+\.\d+-linux-x64)$/u.test(value.runtimeId))) {
    throw new Error('Invalid DSH Companion runtime identity');
  }
  const startupTimeoutMs = value.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1_000 || startupTimeoutMs > 300_000) {
    throw new Error('Invalid DSH Companion runtime startup timeout');
  }
  return {
    version: 1,
    stateFile: resolve(value.stateFile),
    command: value.command,
    args: [...value.args],
    cwd: resolve(value.cwd),
    origin: origin.origin,
    environment: { ...(value.environment ?? {}) },
    environmentFile: value.environmentFile === undefined ? undefined : resolve(value.environmentFile),
    clientModule: value.clientModule === undefined ? undefined : resolve(value.clientModule),
    runtimeId: value.runtimeId,
    startupTimeoutMs,
  };
}

function stopProcessTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let timer;
  await Promise.race([
    new Promise((resolveExit) => { child.once('exit', resolveExit); }),
    new Promise((resolveTimeout) => {
      timer = setTimeout(resolveTimeout, timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
    }
    await new Promise((resolveExit) => { child.once('exit', resolveExit); });
  }
}

async function readEnvironmentFile(path) {
  if (path === undefined) return {};
  const text = await readFile(path, 'utf8');
  const environment = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    const name = separator < 0 ? '' : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1);
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(name) || value.length === 0) {
      throw new Error(`Invalid environment entry in ${path}`);
    }
    environment[name] = value;
  }
  return environment;
}

async function removeOwnState(path, instanceId) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (value?.instanceId === instanceId) await rm(path, { force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') console.error(`Unable to remove runtime state: ${safeMessage(error)}`);
  }
}

function stripAnsi(value) {
  return value.replaceAll(/\x1B\[[0-?]*[ -/]*[@-~]/gu, '');
}

function redactLaunchTokens(value) {
  return value.replaceAll(LAUNCH_TOKEN_PATTERN, '$1[redacted]');
}

function safeMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function main() {
  const configPath = process.argv[2];
  if (configPath === undefined) throw new Error('Usage: supervisor.mjs <config.json>');
  const config = JSON.parse(await readFile(resolve(configPath), 'utf8'));
  const supervisor = new RuntimeSupervisor(config);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => { void supervisor.stop(signal); });
  }
  process.once('uncaughtException', (error) => {
    console.error(safeMessage(error));
    void supervisor.stop('uncaught exception').finally(() => { process.exitCode = 1; });
  });
  process.once('unhandledRejection', (error) => {
    console.error(safeMessage(error));
    void supervisor.stop('unhandled rejection').finally(() => { process.exitCode = 1; });
  });
  await supervisor.start();
  await supervisor.wait();
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
