import { type ChildProcessWithoutNullStreams } from 'child_process';
import crypto from 'crypto';
import { app } from 'electron';
import { EventEmitter } from 'events';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { parseHermesDotenvText } from './hermesConfig';
import { isSystemProxyEnabled, resolveSystemProxyUrl } from './systemProxy';
import {
  preferWindowsExecutablePath,
  spawnSyncWindowsAware,
  spawnWindowsAware,
} from './windowsCommand';

const DEFAULT_GATEWAY_PORT = 18879;
const GATEWAY_PORT_SCAN_LIMIT = 80;
const GATEWAY_BOOT_TIMEOUT_MS = 180_000;
// Short TTL for the "gateway already running" fast path. Five minutes is long
// enough to cover rapid back-and-forth engine switching without making the
// cached port/token stale if the user actually kills the gateway externally.
const HERMES_GATEWAY_FAST_PATH_TTL_MS = 5 * 60 * 1000;

interface HermesGatewayFastPath {
  port: number;
  token: string;
  process: ChildProcessWithoutNullStreams | null;
  ts: number;
}
const GATEWAY_MAX_RESTART_ATTEMPTS = 5;
const GATEWAY_RESTART_DELAYS = [3_000, 5_000, 10_000, 20_000, 30_000];

export type HermesEnginePhase =
  | 'not_installed'
  | 'installing'
  | 'ready'
  | 'starting'
  | 'adopting'
  | 'degraded'
  | 'running'
  | 'error';

export interface HermesEngineStatus {
  phase: HermesEnginePhase;
  version: string | null;
  progressPercent?: number;
  message?: string;
  canRetry: boolean;
}

export interface HermesGatewayConnectionInfo {
  version: string | null;
  port: number | null;
  token: string | null;
  url: string | null;
}

interface HermesEngineManagerEvents {
  status: (status: HermesEngineStatus) => void;
}

type HermesInstallProgressPhase =
  | 'starting'
  | 'installing'
  | 'verifying'
  | 'success'
  | 'error'
  | 'unsupported';

type RuntimeMetadata = {
  commandPath: string | null;
  version: string | null;
  expectedPathHint: string;
};

type GatewayCandidate = {
  source: 'wesight-state' | 'local-hermes-root' | 'local-hermes-profile';
  runtimeRoot: string;
  envPath: string | null;
  statePath: string | null;
  lockPath: string | null;
  pid: number | null;
  port: number | null;
  token: string | null;
  tokenSource: string | null;
  logPath: string | null;
};

type GatewayProbeResult = {
  port: number | null;
  token: string | null;
  healthy: boolean;
  adopted: boolean;
  staleLock: boolean;
  lockHeldByOther: boolean;
  lastError: string | null;
  pid: number | null;
  lockPath: string | null;
  logPath: string | null;
  runtimeRoot: string | null;
  tokenSource: string | null;
  source: GatewayCandidate['source'] | null;
  envPath?: string | null;
};

export interface HermesEngineDiagnostics {
  commandPath: string | null;
  version: string | null;
  source: GatewayCandidate['source'] | null;
  runtimeRoot: string | null;
  envPath: string | null;
  port: number | null;
  tokenSource: string | null;
  lockPath: string | null;
  logPath: string | null;
  processId: number | null;
};

const ensureDir = (dirPath: string): void => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const findPath = (candidates: string[]): string | null => {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
};

const buildHermesSearchPath = (): string => {
  const isWindows = process.platform === 'win32';
  const paths = [
    path.join(os.homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  
  if (isWindows) {
    const appData = process.env.APPDATA || '';
    const localAppData = process.env.LOCALAPPDATA || '';
    paths.push(
      // npm全局
      path.join(appData, 'npm'),
      // Hermes Windows launcher
      path.join(localAppData, 'hermes', 'bin'),
      // 本地安装
      path.join(os.homedir(), '.hermes', 'bin'),
      // uv安装
      path.join(localAppData, 'hermes', 'hermes-agent', 'venv', 'Scripts'),
    );
  }
  
  paths.push(process.env.PATH ?? '');
  return paths.join(path.delimiter);
};

const isWslCliBridgeEnabled = (): boolean => (
  process.platform === 'win32' && process.env.WESIGHT_ENABLE_WSL_CLI_BRIDGES === '1'
);

const progressPercentForInstallPhase = (phase: HermesInstallProgressPhase): number | undefined => {
  switch (phase) {
    case 'starting':
      return 8;
    case 'installing':
      return 40;
    case 'verifying':
      return 85;
    case 'success':
      return 100;
    default:
      return undefined;
  }
};

const parseJsonFile = <T>(filePath: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
};

const isPortAvailable = async (port: number): Promise<boolean> => {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
};

const fetchWithTimeout = async (url: string, token: string, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
      cache: 'no-store',
    });
  } finally {
    clearTimeout(timeout);
  }
};

const isProcessAlive = (child: ChildProcessWithoutNullStreams | null): child is ChildProcessWithoutNullStreams => {
  return Boolean(child && child.pid && child.exitCode === null);
};

export class HermesEngineManager extends EventEmitter {
  private readonly baseDir: string;
  private readonly logsDir: string;
  private readonly stateDir: string;
  private readonly configPath: string;
  private readonly envPath: string;
  private readonly gatewayTokenPath: string;
  private readonly gatewayPortPath: string;
  private readonly gatewayLogPath: string;
  private readonly gatewayLockPath: string;

  private desiredVersion: string | null;
  private status: HermesEngineStatus;
  private runtimeMetadata: RuntimeMetadata;
  private lastProbe: GatewayProbeResult | null = null;
  private gatewayProcess: ChildProcessWithoutNullStreams | null = null;
  private gatewayPort: number | null = null;
  private gatewayRestartAttempt = 0;
  private gatewayRestartTimer: NodeJS.Timeout | null = null;
  private shutdownRequested = false;
  private startGatewayPromise: Promise<HermesEngineStatus> | null = null;
  private secretEnvVars: Record<string, string> = {};
  // Cross-instance fast path: a fresh `startGateway()` within the TTL skips
  // the port scan / state-file write / status broadcast and returns the
  // previously-captured port + token. This is what makes engine switching
  // back to Hermes within a few minutes feel instant.
  private static readonly gatewayFastPathCache: Map<string, HermesGatewayFastPath> = new Map();

  constructor() {
    super();

    const userDataPath = app.getPath('userData');
    this.baseDir = path.join(userDataPath, 'hermes');
    this.logsDir = path.join(this.baseDir, 'logs');
    this.stateDir = path.join(this.baseDir, 'state');
    this.configPath = path.join(os.homedir(), '.hermes', 'config.yaml');
    this.envPath = path.join(os.homedir(), '.hermes', '.env');
    this.gatewayTokenPath = path.join(this.stateDir, 'gateway-token');
    this.gatewayPortPath = path.join(this.stateDir, 'gateway-port.json');
    this.gatewayLogPath = path.join(this.logsDir, 'gateway.log');
    this.gatewayLockPath = path.join(this.stateDir, 'gateway.lock');

    ensureDir(this.baseDir);
    ensureDir(this.logsDir);
    ensureDir(this.stateDir);

    const runtime = this.resolveRuntimeMetadata();
    this.runtimeMetadata = runtime;
    this.desiredVersion = runtime.version;
    this.status = runtime.commandPath
      ? {
          phase: 'ready',
          version: this.desiredVersion,
          message: `Hermes Agent CLI is ready at ${runtime.commandPath}.`,
          canRetry: false,
        }
      : {
          phase: 'not_installed',
          version: null,
          message: `Hermes Agent CLI was not found. Expected one of: ${runtime.expectedPathHint}`,
          canRetry: true,
        };
  }

  override on<U extends keyof HermesEngineManagerEvents>(
    event: U,
    listener: HermesEngineManagerEvents[U],
  ): this {
    return super.on(event, listener);
  }

  override emit<U extends keyof HermesEngineManagerEvents>(
    event: U,
    ...args: Parameters<HermesEngineManagerEvents[U]>
  ): boolean {
    return super.emit(event, ...args);
  }

  getStatus(): HermesEngineStatus {
    return { ...this.status };
  }

  getStateDir(): string {
    return this.stateDir;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  getEnvPath(): string {
    return this.envPath;
  }

  setSecretEnvVars(vars: Record<string, string>): void {
    this.secretEnvVars = vars;
  }

  getSecretEnvVars(): Record<string, string> {
    return this.secretEnvVars;
  }

  reportInstallProgress(progress: {
    phase: HermesInstallProgressPhase;
    message: string;
    detail?: string;
  }): void {
    const message = progress.detail
      ? `${progress.message} ${progress.detail}`
      : progress.message;
    if (progress.phase === 'error' || progress.phase === 'unsupported') {
      this.setStatus({
        phase: 'error',
        version: this.status.version,
        message,
        canRetry: true,
      });
      return;
    }

    if (progress.phase === 'success') {
      const runtime = this.resolveRuntimeMetadata();
      this.desiredVersion = runtime.version || this.desiredVersion;
      this.setStatus({
        phase: runtime.commandPath ? 'ready' : 'not_installed',
        version: runtime.version || this.status.version,
        progressPercent: 100,
        message,
        canRetry: !runtime.commandPath,
      });
      return;
    }

    this.setStatus({
      phase: 'installing',
      version: this.status.version,
      progressPercent: progressPercentForInstallPhase(progress.phase),
      message,
      canRetry: false,
    });
  }

  getConnectionInfo(): HermesGatewayConnectionInfo {
    const port = this.lastProbe?.port ?? this.gatewayPort ?? this.readGatewayPort();
    const token = this.lastProbe?.token ?? this.readGatewayToken();
    return {
      version: this.status.version,
      port,
      token,
      url: port ? `http://127.0.0.1:${port}` : null,
    };
  }

  getDiagnostics(): HermesEngineDiagnostics {
    return {
      commandPath: this.runtimeMetadata.commandPath,
      version: this.runtimeMetadata.version,
      source: this.lastProbe?.source ?? null,
      runtimeRoot: this.lastProbe?.runtimeRoot ?? null,
      envPath: this.resolveDiagnosticsEnvPath(),
      port: this.lastProbe?.port ?? this.gatewayPort ?? this.readGatewayPort(),
      tokenSource: this.lastProbe?.tokenSource ?? null,
      lockPath: this.lastProbe?.lockPath ?? this.gatewayLockPath,
      logPath: this.lastProbe?.logPath ?? this.gatewayLogPath,
      processId: this.lastProbe?.pid ?? this.gatewayProcess?.pid ?? null,
    };
  }

  async ensureReady(): Promise<HermesEngineStatus> {
    const runtime = this.resolveRuntimeMetadata();
    this.runtimeMetadata = runtime;
    if (!runtime.commandPath) {
      this.setStatus({
        phase: 'not_installed',
        version: null,
        message: `Hermes Agent CLI was not found. Expected one of: ${runtime.expectedPathHint}`,
        canRetry: true,
      });
      return this.getStatus();
    }

    this.desiredVersion = runtime.version;
    if (this.status.phase !== 'running' && this.status.phase !== 'starting') {
      this.setStatus({
        phase: 'ready',
        version: this.desiredVersion,
        message: `Hermes Agent CLI is ready at ${runtime.commandPath}.`,
        canRetry: false,
      });
    }
    return this.getStatus();
  }

  async startGateway(): Promise<HermesEngineStatus> {
    if (this.startGatewayPromise) {
      return this.startGatewayPromise;
    }
    this.startGatewayPromise = this.doStartGateway().finally(() => {
      this.startGatewayPromise = null;
    });
    return this.startGatewayPromise;
  }

  async restartGateway(): Promise<HermesEngineStatus> {
    await this.stopGateway();
    this.gatewayRestartAttempt = 0;
    return this.startGateway();
  }

  async stopGateway(): Promise<void> {
    this.shutdownRequested = true;
    if (this.gatewayRestartTimer) {
      clearTimeout(this.gatewayRestartTimer);
      this.gatewayRestartTimer = null;
    }
    if (this.gatewayProcess) {
      await this.stopGatewayProcess(this.gatewayProcess);
      this.gatewayProcess = null;
    }
    const runtime = this.resolveRuntimeMetadata();
    this.setStatus({
      phase: runtime.commandPath ? 'ready' : 'not_installed',
      version: runtime.version,
      message: runtime.commandPath
        ? 'Hermes Agent gateway is stopped.'
        : `Hermes Agent CLI was not found. Expected one of: ${runtime.expectedPathHint}`,
      canRetry: !runtime.commandPath,
    });
  }

  private async doStartGateway(): Promise<HermesEngineStatus> {
    // Short TTL cache: callers that flip back to Hermes within a few minutes
    // skip port probes, state file writes, and status broadcasts. The previous
    // implementation re-ran everything on every switch, which was the
    // dominant contributor to "engine switch is sluggish" reports.
    const cached = HermesEngineManager.gatewayFastPathCache.get(this.desiredVersion);
    if (cached && Date.now() - cached.ts < HERMES_GATEWAY_FAST_PATH_TTL_MS) {
      this.gatewayPort = cached.port;
      this.gatewayProcess = cached.process ?? null;
      this.setStatus({
        phase: 'running',
        version: this.desiredVersion,
        progressPercent: 100,
        message: `Hermes Agent gateway is running on loopback:${cached.port} (cached).`,
        canRetry: false,
      });
      return this.getStatus();
    }

    this.shutdownRequested = false;
    const ensured = await this.ensureReady();
    if (ensured.phase !== 'ready' && ensured.phase !== 'running') {
      return ensured;
    }

    const existingGateway = await this.probeExistingGateway();
    if (existingGateway.healthy && existingGateway.port && existingGateway.token) {
      this.gatewayPort = existingGateway.port;
      this.syncGatewayStateFiles(existingGateway.port, existingGateway.token);
      this.gatewayRestartAttempt = 0;
      this.setStatus({
        phase: existingGateway.adopted ? 'adopting' : 'running',
        version: this.desiredVersion,
        progressPercent: 100,
        message: existingGateway.adopted
          ? `Adopted existing Hermes Agent gateway on loopback:${existingGateway.port} from ${existingGateway.runtimeRoot || 'external runtime'}.`
          : `Hermes Agent gateway is running on loopback:${existingGateway.port}.`,
        canRetry: false,
      });
      if (existingGateway.adopted) {
        this.setStatus({
          phase: 'running',
          version: this.desiredVersion,
          progressPercent: 100,
          message: `Hermes Agent gateway is running on loopback:${existingGateway.port}.`,
          canRetry: false,
        });
      }
      return this.getStatus();
    }

    if (existingGateway.lockHeldByOther && !existingGateway.staleLock) {
      this.setStatus({
        phase: 'degraded',
        version: this.desiredVersion,
        message: existingGateway.lastError || 'Hermes Agent lock is held by another instance that WeSight cannot adopt.',
        canRetry: true,
      });
      return this.getStatus();
    }

    if (existingGateway.staleLock) {
      this.clearGatewayLock(existingGateway.lockPath);
    }

    if (isProcessAlive(this.gatewayProcess)) {
      const port = this.gatewayPort ?? this.readGatewayPort();
      const token = this.readGatewayToken();
      if (port && token && await this.isGatewayHealthy(port, token)) {
        HermesEngineManager.gatewayFastPathCache.set(this.desiredVersion, {
          port,
          token,
          process: this.gatewayProcess,
          ts: Date.now(),
        });
        this.setStatus({
          phase: 'running',
          version: this.desiredVersion,
          message: `Hermes Agent gateway is running on loopback:${port}.`,
          canRetry: false,
        });
        return this.getStatus();
      }
      await this.stopGatewayProcess(this.gatewayProcess);
      this.gatewayProcess = null;
    }

    const runtime = this.resolveRuntimeMetadata();
    this.runtimeMetadata = runtime;
    if (!runtime.commandPath) {
      this.setStatus({
        phase: 'not_installed',
        version: null,
        message: `Hermes Agent CLI was not found. Expected one of: ${runtime.expectedPathHint}`,
        canRetry: true,
      });
      return this.getStatus();
    }

    const token = this.ensureGatewayToken();
    const port = await this.resolveGatewayPort();
    this.gatewayPort = port;
    this.writeGatewayPort(port);
    this.ensureGatewayStateFiles();

    this.setStatus({
      phase: 'starting',
      version: runtime.version,
      progressPercent: 10,
      message: 'Starting Hermes Agent gateway...',
      canRetry: false,
    });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HERMES_CONFIG_PATH: this.configPath,
      HERMES_DOTENV_PATH: this.envPath,
      HERMES_ACCEPT_HOOKS: '1',
      ...this.secretEnvVars,
      API_SERVER_ENABLED: 'true',
      API_SERVER_HOST: '127.0.0.1',
      API_SERVER_PORT: String(port),
      API_SERVER_KEY: token,
      HERMES_GATEWAY_TOKEN: token,
      HERMES_GATEWAY_PORT: String(port),
      HERMES_LOG_LEVEL: 'INFO',
      PYTHONUNBUFFERED: '1',
      PATH: buildHermesSearchPath(),
    };
    if (isSystemProxyEnabled()) {
      const proxyUrl = await resolveSystemProxyUrl('https://api.openai.com');
      if (proxyUrl) {
        env.http_proxy = proxyUrl;
        env.https_proxy = proxyUrl;
        env.HTTP_PROXY = proxyUrl;
        env.HTTPS_PROXY = proxyUrl;
      }
    }

    const child = spawnWindowsAware(
      runtime.commandPath,
      ['gateway', 'run', '--accept-hooks'],
      {
        cwd: os.homedir(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: process.platform === 'win32',
      },
    );
    this.gatewayProcess = child;
    this.attachGatewayLogs(child);
    this.attachGatewayExitHandlers(child);

    this.setStatus({
      phase: 'starting',
      version: runtime.version,
      progressPercent: 35,
      message: 'Waiting for Hermes Agent API server...',
      canRetry: false,
    });

    const healthy = await this.waitForGatewayHealthy(port, token);
    if (!healthy) {
      this.setStatus({
        phase: 'error',
        version: runtime.version,
        message: `Hermes Agent gateway did not become ready on loopback:${port}.`,
        canRetry: true,
      });
      return this.getStatus();
    }

    this.gatewayRestartAttempt = 0;
    HermesEngineManager.gatewayFastPathCache.set(this.desiredVersion, {
      port,
      token,
      process: this.gatewayProcess,
      ts: Date.now(),
    });
    this.setStatus({
      phase: 'running',
      version: runtime.version,
      progressPercent: 100,
      message: `Hermes Agent gateway is running on loopback:${port}.`,
      canRetry: false,
    });
    return this.getStatus();
  }

  private resolveRuntimeMetadata(): RuntimeMetadata {
    const isWindows = process.platform === 'win32';
    const appData = process.env.APPDATA || '';
    const localAppData = process.env.LOCALAPPDATA || '';
    const homeDir = os.homedir();
    const userName = path.basename(homeDir);

    const candidates = [
      this.resolveCommandFromShell('hermes'),
      // Unix路径
      path.join(homeDir, '.local', 'bin', 'hermes'),
      '/opt/homebrew/bin/hermes',
      '/usr/local/bin/hermes',
    ];

    if (isWindows) {
      candidates.push(
        // npm全局
        path.join(appData, 'npm', 'hermes.exe'),
        path.join(appData, 'npm', 'hermes.cmd'),
        // Hermes Windows launcher
        path.join(localAppData, 'hermes', 'bin', 'hermes.exe'),
        path.join(localAppData, 'hermes', 'bin', 'hermes.cmd'),
        // 本地安装
        path.join(homeDir, '.local', 'bin', 'hermes.exe'),
        path.join(homeDir, '.hermes', 'bin', 'hermes.cmd'),
        path.join(homeDir, '.hermes', 'bin', 'hermes.exe'),
        // uv安装
        path.join(localAppData, 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'),
        // Hermes Studio
        'D:\\Program Files\\Hermes Studio\\resources\\python\\Scripts\\hermes.cmd',
        'C:\\Program Files\\Hermes Studio\\resources\\python\\Scripts\\hermes.cmd',
      );
      if (isWslCliBridgeEnabled()) {
        candidates.push(
          `\\\\wsl$\\Ubuntu\\home\\${userName}\\.local\\bin\\hermes`,
          `\\\\wsl$\\Ubuntu\\home\\${userName}\\.hermes\\bin\\hermes`,
          `\\\\wsl$\\Ubuntu\\usr\\local\\bin\\hermes`,
        );
      }
    }

    const filteredCandidates = candidates.filter((value): value is string => Boolean(value));
    const commandPath = isWindows
      ? preferWindowsExecutablePath(filteredCandidates.filter((candidate) => Boolean(findPath([candidate]))))
      : findPath(filteredCandidates);
    const expectedPathHint = [
      'PATH:hermes',
      path.join(os.homedir(), '.local', 'bin', 'hermes'),
      '/opt/homebrew/bin/hermes',
      '/usr/local/bin/hermes',
      ...(isWindows ? [
        path.join(appData, 'npm', 'hermes.exe'),
        path.join(appData, 'npm', 'hermes.cmd'),
        path.join(localAppData, 'hermes', 'bin', 'hermes.exe'),
        path.join(localAppData, 'hermes', 'bin', 'hermes.cmd'),
        path.join(os.homedir(), '.hermes', 'bin', 'hermes.cmd'),
        path.join(os.homedir(), '.hermes', 'bin', 'hermes.exe'),
        path.join(localAppData, 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'),
      ] : []),
    ].join(', ');

    if (!commandPath) {
      return { commandPath: null, version: null, expectedPathHint };
    }
    return {
      commandPath,
      version: this.readCommandVersion(commandPath),
      expectedPathHint,
    };
  }

  private resolveCommandFromShell(command: string): string | null {
    if (process.platform === 'win32') {
      const result = spawnSyncWindowsAware('where', [command], {
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          PATH: buildHermesSearchPath(),
        },
        windowsHide: true,
      });
      if (result.status !== 0) return null;
      return preferWindowsExecutablePath(result.stdout.split(/\r?\n/));
    }

    const shell = process.env.SHELL || '/bin/zsh';
    const result = spawnSyncWindowsAware(shell, ['-lc', `command -v ${command}`], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: buildHermesSearchPath(),
      },
    });
    if (result.status !== 0) return null;
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
  }

  private readCommandVersion(commandPath: string): string | null {
    const result = spawnSyncWindowsAware(commandPath, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: buildHermesSearchPath(),
      },
      windowsHide: process.platform === 'win32',
    });
    if (result.status !== 0) return null;
    return (result.stdout || result.stderr || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
  }

  private ensureGatewayToken(): string {
    const existing = this.readGatewayToken();
    if (existing) return existing;
    const token = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(this.gatewayTokenPath, token, { encoding: 'utf8', mode: 0o600 });
    return token;
  }

  private readGatewayToken(): string | null {
    try {
      const raw = fs.readFileSync(this.gatewayTokenPath, 'utf8').trim();
      return raw || null;
    } catch {
      return null;
    }
  }

  private async resolveGatewayPort(): Promise<number> {
    const saved = this.readGatewayPort();
    if (saved && await isPortAvailable(saved)) {
      return saved;
    }
    for (let offset = 0; offset < GATEWAY_PORT_SCAN_LIMIT; offset += 1) {
      const port = DEFAULT_GATEWAY_PORT + offset;
      if (await isPortAvailable(port)) {
        return port;
      }
    }
    throw new Error('No available loopback port found for Hermes Agent gateway.');
  }

  private readGatewayPort(): number | null {
    const parsed = parseJsonFile<{ port?: number }>(this.gatewayPortPath);
    return typeof parsed?.port === 'number' && Number.isFinite(parsed.port)
      ? parsed.port
      : null;
  }

  private writeGatewayPort(port: number): void {
    fs.writeFileSync(this.gatewayPortPath, `${JSON.stringify({ port }, null, 2)}\n`, 'utf8');
  }

  private syncGatewayStateFiles(port: number, token: string): void {
    this.writeGatewayPort(port);
    fs.writeFileSync(this.gatewayTokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  private ensureGatewayStateFiles(): void {
    ensureDir(path.dirname(this.configPath));
    if (!fs.existsSync(this.envPath)) {
      fs.writeFileSync(this.envPath, '', { encoding: 'utf8', mode: 0o600 });
    }
  }

  private async waitForGatewayHealthy(port: number, token: string): Promise<boolean> {
    const deadline = Date.now() + GATEWAY_BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!isProcessAlive(this.gatewayProcess)) {
        return false;
      }
      if (await this.isGatewayHealthy(port, token)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  }

  private async isGatewayHealthy(port: number, token: string): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(`http://127.0.0.1:${port}/v1/models`, token, 1500);
      return response.ok;
    } catch {
      return false;
    }
  }

  private async probeExistingGateway(): Promise<GatewayProbeResult> {
    const candidates = this.resolveGatewayCandidates();
    let lockHeldByOther = false;
    let staleLock = false;
    let lastError: string | null = null;
    let lastFailed: GatewayCandidate | null = null;
    for (const candidate of candidates) {
      if (candidate.port && candidate.token && await this.isGatewayHealthy(candidate.port, candidate.token)) {
        const adopted = !isProcessAlive(this.gatewayProcess) || candidate.source !== 'wesight-state';
        const result: GatewayProbeResult = {
          port: candidate.port,
          token: candidate.token,
          healthy: true,
          adopted,
          staleLock: false,
          lockHeldByOther: false,
          lastError: null,
          pid: candidate.pid,
          lockPath: candidate.lockPath,
          logPath: candidate.logPath,
          runtimeRoot: candidate.runtimeRoot,
          tokenSource: candidate.tokenSource,
          source: candidate.source,
          envPath: candidate.envPath,
        };
        this.lastProbe = result;
        return result;
      }
      const pidAlive = candidate.pid ? this.isPidAlive(candidate.pid) : false;
      if (candidate.lockPath && fs.existsSync(candidate.lockPath)) {
        lastFailed = candidate;
        if (pidAlive) {
          lockHeldByOther = true;
          lastError = candidate.port && candidate.token
            ? `Hermes gateway is locked by pid ${candidate.pid} in ${candidate.runtimeRoot}, but WeSight could not authenticate to ${candidate.port}.`
            : `Hermes gateway is locked by pid ${candidate.pid} in ${candidate.runtimeRoot}, but the API port or token could not be resolved.`;
        } else {
          staleLock = true;
          lastError = `Hermes stale lock found at ${candidate.lockPath}.`;
        }
      }
    }
    const result: GatewayProbeResult = {
      port: lastFailed?.port ?? this.gatewayPort ?? this.readGatewayPort(),
      token: lastFailed?.token ?? this.readGatewayToken(),
      healthy: false,
      adopted: false,
      staleLock,
      lockHeldByOther,
      lastError,
      pid: lastFailed?.pid ?? null,
      lockPath: lastFailed?.lockPath ?? (staleLock || lockHeldByOther ? this.gatewayLockPath : null),
      logPath: lastFailed?.logPath ?? this.gatewayLogPath,
      runtimeRoot: lastFailed?.runtimeRoot ?? null,
      tokenSource: lastFailed?.tokenSource ?? null,
      source: lastFailed?.source ?? null,
      envPath: lastFailed?.envPath ?? null,
    };
    this.lastProbe = result;
    return result;
  }

  private clearGatewayLock(lockPath?: string | null): void {
    try {
      const targetPath = lockPath || this.gatewayLockPath;
      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
      }
    } catch (error) {
      console.warn('[HermesEngine] failed to clear gateway lock:', error);
    }
  }

  private resolveGatewayCandidates(): GatewayCandidate[] {
    const candidates: GatewayCandidate[] = [];
    const seen = new Set<string>();
    const pushCandidate = (candidate: GatewayCandidate) => {
      const key = [
        candidate.source,
        candidate.runtimeRoot,
        candidate.lockPath || '',
        candidate.pid || '',
        candidate.port || '',
        candidate.tokenSource || '',
      ].join('|');
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(candidate);
    };

    pushCandidate({
      source: 'wesight-state',
      runtimeRoot: this.baseDir,
      envPath: this.envPath,
      statePath: this.gatewayPortPath,
      lockPath: this.gatewayLockPath,
      pid: this.parseGatewayPid(this.gatewayLockPath),
      port: this.gatewayPort ?? this.readGatewayPort(),
      token: this.readGatewayToken(),
      tokenSource: fs.existsSync(this.gatewayTokenPath) ? this.gatewayTokenPath : null,
      logPath: this.gatewayLogPath,
    });

    for (const runtimeRoot of this.resolveLocalHermesRuntimeRoots()) {
      const rootEnvPath = path.join(runtimeRoot, '.env');
      const rootStatePath = path.join(runtimeRoot, 'gateway_state.json');
      const rootLockPath = path.join(runtimeRoot, 'gateway.lock');
      const rootLogPath = path.join(runtimeRoot, 'logs', 'gateway.log');
      pushCandidate({
        source: 'local-hermes-root',
        runtimeRoot,
        envPath: rootEnvPath,
        statePath: rootStatePath,
        lockPath: rootLockPath,
        pid: this.parseGatewayPid(rootLockPath) ?? this.parseGatewayPid(rootStatePath),
        port: this.readPortFromGatewayLog(rootLogPath),
        token: this.readTokenFromEnv(rootEnvPath),
        tokenSource: fs.existsSync(rootEnvPath) ? rootEnvPath : null,
        logPath: rootLogPath,
      });

      const profilesDir = path.join(runtimeRoot, 'profiles');
      if (!fs.existsSync(profilesDir)) continue;
      for (const entry of fs.readdirSync(profilesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const profileRoot = path.join(profilesDir, entry.name);
        const profileEnvPath = path.join(profileRoot, '.env');
        const profileStatePath = path.join(profileRoot, 'gateway_state.json');
        const profileLockPath = path.join(profileRoot, 'gateway.lock');
        const profileLogPath = path.join(profileRoot, 'logs', 'gateway.log');
        pushCandidate({
          source: 'local-hermes-profile',
          runtimeRoot: profileRoot,
          envPath: profileEnvPath,
          statePath: profileStatePath,
          lockPath: profileLockPath,
          pid: this.parseGatewayPid(profileLockPath)
            ?? this.parseGatewayPid(path.join(profileRoot, 'gateway.pid'))
            ?? this.parseGatewayPid(profileStatePath),
          port: this.readPortFromGatewayLog(profileLogPath) ?? this.readPortFromGatewayLog(rootLogPath),
          token: this.readTokenFromEnv(profileEnvPath) ?? this.readTokenFromEnv(rootEnvPath),
          tokenSource: fs.existsSync(profileEnvPath) ? profileEnvPath : (fs.existsSync(rootEnvPath) ? rootEnvPath : null),
          logPath: fs.existsSync(profileLogPath) ? profileLogPath : rootLogPath,
        });
      }
    }
    return candidates;
  }

  private resolveLocalHermesRuntimeRoots(): string[] {
    if (process.platform !== 'win32') {
      return [];
    }
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const roots = [
      path.join(localAppData, 'hermes'),
    ];
    return roots.filter((root, index, values) => values.indexOf(root) === index && fs.existsSync(root));
  }

  private parseGatewayPid(filePath: string): number | null {
    const parsed = parseJsonFile<{ pid?: number }>(filePath);
    return typeof parsed?.pid === 'number' && Number.isFinite(parsed.pid)
      ? parsed.pid
      : null;
  }

  private readTokenFromEnv(envPath: string): string | null {
    try {
      const text = fs.readFileSync(envPath, 'utf8');
      const env = parseHermesDotenvText(text);
      const token = env.API_SERVER_KEY || env.HERMES_GATEWAY_TOKEN || env.WEBUI_TOKEN;
      return token?.trim() || null;
    } catch {
      return null;
    }
  }

  private readPortFromGatewayLog(logPath: string): number | null {
    try {
      const text = fs.readFileSync(logPath, 'utf8');
      const matches = [...text.matchAll(/API server listening on http:\/\/127\.0\.0\.1:(\d+)/g)];
      const raw = matches[matches.length - 1]?.[1];
      if (!raw) return null;
      const port = Number.parseInt(raw, 10);
      return Number.isFinite(port) ? port : null;
    } catch {
      return null;
    }
  }

  private isPidAlive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private resolveDiagnosticsEnvPath(): string | null {
    if (this.lastProbe?.envPath) {
      return this.lastProbe.envPath;
    }
    if (fs.existsSync(this.envPath)) {
      return this.envPath;
    }
    return null;
  }

  private attachGatewayLogs(child: ChildProcessWithoutNullStreams): void {
    const append = (source: string, text: string) => {
      const lines = text.split(/\r?\n/).filter(Boolean);
      if (lines.length === 0) return;
      const payload = lines.map((line) => `[${new Date().toISOString()}] [${source}] ${line}`).join('\n') + '\n';
      fs.appendFile(this.gatewayLogPath, payload, () => {});
    };
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk.toString('utf8')));
  }

  private attachGatewayExitHandlers(child: ChildProcessWithoutNullStreams): void {
    child.on('error', (error) => {
      this.setStatus({
        phase: 'error',
        version: this.desiredVersion,
        message: `Hermes Agent gateway failed to start: ${error.message}`,
        canRetry: true,
      });
    });

    child.on('exit', (code, signal) => {
      if (this.gatewayProcess === child) {
        this.gatewayProcess = null;
      }
      if (this.shutdownRequested) {
        return;
      }
      const message = `Hermes Agent gateway exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`;
      if (this.gatewayRestartAttempt >= GATEWAY_MAX_RESTART_ATTEMPTS) {
        this.setStatus({
          phase: 'error',
          version: this.desiredVersion,
          message,
          canRetry: true,
        });
        return;
      }
      const delay = GATEWAY_RESTART_DELAYS[Math.min(this.gatewayRestartAttempt, GATEWAY_RESTART_DELAYS.length - 1)];
      this.gatewayRestartAttempt += 1;
      this.setStatus({
        phase: 'starting',
        version: this.desiredVersion,
        message: `${message} Restarting in ${Math.round(delay / 1000)}s...`,
        canRetry: false,
      });
      this.gatewayRestartTimer = setTimeout(() => {
        this.gatewayRestartTimer = null;
        void this.startGateway();
      }, delay);
    });
  }

  private async stopGatewayProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (!isProcessAlive(child)) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignore shutdown races.
        }
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timeout);
        resolve();
      }
    });
  }

  private setStatus(status: HermesEngineStatus): void {
    this.status = status;
    this.emit('status', this.getStatus());
  }
}
