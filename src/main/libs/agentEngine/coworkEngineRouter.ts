import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { EventEmitter } from 'events';

import {
  CoworkAgentEngine as CoworkAgentEngineValue,
  isCoworkAgentEngine,
  RuntimeCallStatus,
} from '../../../shared/cowork/constants';
import type { RuntimeTelemetryTracker } from '../runtimeTelemetryTracker';
import type {
  CoworkAgentEngine,
  CoworkContinueOptions,
  CoworkRuntime,
  CoworkRuntimeEvents,
  CoworkStartOptions,
} from './types';
import { ENGINE_SWITCHED_CODE } from './types';
import { inferEngineFromQuery } from './queryIntentRouter';
import { isAllowedSkill } from '../skillWhitelist';

type RouterDeps = {
  getCurrentEngine: () => CoworkAgentEngine;
  openclawRuntime: CoworkRuntime;
  hermesRuntime: CoworkRuntime;
  claudeRuntime: CoworkRuntime;
  claudeCodeRuntime: CoworkRuntime;
  codexRuntime: CoworkRuntime;
  codexAppRuntime: CoworkRuntime;
  openCodeRuntime: CoworkRuntime;
  grokBuildRuntime: CoworkRuntime;
  qwenCodeRuntime: CoworkRuntime;
  deepSeekTuiRuntime: CoworkRuntime;
  telemetryTracker?: RuntimeTelemetryTracker;
};

export class CoworkEngineRouter extends EventEmitter implements CoworkRuntime {
  private readonly getCurrentEngine: () => CoworkAgentEngine;
  private readonly runtimeByEngine: Record<CoworkAgentEngine, CoworkRuntime>;
  private readonly sessionEngine = new Map<string, CoworkAgentEngine>();
  private readonly requestEngine = new Map<string, CoworkAgentEngine>();
  private readonly requestSession = new Map<string, string>();
  private readonly telemetryTracker?: RuntimeTelemetryTracker;
  private currentEngine: CoworkAgentEngine;

  constructor(deps: RouterDeps) {
    super();
    this.getCurrentEngine = deps.getCurrentEngine;
    this.runtimeByEngine = {
      [CoworkAgentEngineValue.OpenClaw]: deps.openclawRuntime,
      [CoworkAgentEngineValue.Hermes]: deps.hermesRuntime,
      [CoworkAgentEngineValue.YdCowork]: deps.claudeRuntime,
      [CoworkAgentEngineValue.ClaudeCode]: deps.claudeCodeRuntime,
      [CoworkAgentEngineValue.Codex]: deps.codexRuntime,
      [CoworkAgentEngineValue.CodexApp]: deps.codexAppRuntime,
      [CoworkAgentEngineValue.OpenCode]: deps.openCodeRuntime,
      [CoworkAgentEngineValue.GrokBuild]: deps.grokBuildRuntime,
      [CoworkAgentEngineValue.QwenCode]: deps.qwenCodeRuntime,
      [CoworkAgentEngineValue.DeepSeekTui]: deps.deepSeekTuiRuntime,
    };
    this.currentEngine = this.safeResolveEngine();
    this.telemetryTracker = deps.telemetryTracker;

    this.bindRuntimeEvents(CoworkAgentEngineValue.OpenClaw, deps.openclawRuntime);
    this.bindRuntimeEvents(CoworkAgentEngineValue.Hermes, deps.hermesRuntime);
    this.bindRuntimeEvents(CoworkAgentEngineValue.YdCowork, deps.claudeRuntime);
    this.bindRuntimeEvents(CoworkAgentEngineValue.ClaudeCode, deps.claudeCodeRuntime);
    this.bindRuntimeEvents(CoworkAgentEngineValue.Codex, deps.codexRuntime);
    this.bindRuntimeEvents(CoworkAgentEngineValue.CodexApp, deps.codexAppRuntime);
    this.bindRuntimeEvents(CoworkAgentEngineValue.OpenCode, deps.openCodeRuntime);
    this.bindRuntimeEvents(CoworkAgentEngineValue.GrokBuild, deps.grokBuildRuntime);
    this.bindRuntimeEvents(CoworkAgentEngineValue.QwenCode, deps.qwenCodeRuntime);
    this.bindRuntimeEvents(CoworkAgentEngineValue.DeepSeekTui, deps.deepSeekTuiRuntime);
  }

  override on<U extends keyof CoworkRuntimeEvents>(
    event: U,
    listener: CoworkRuntimeEvents[U],
  ): this {
    return super.on(event, listener);
  }

  override off<U extends keyof CoworkRuntimeEvents>(
    event: U,
    listener: CoworkRuntimeEvents[U],
  ): this {
    return super.off(event, listener);
  }

  async startSession(sessionId: string, prompt: string, options: CoworkStartOptions = {}): Promise<void> {
    // Only apply intent-based routing when the user did NOT explicitly pick
    // an engine. If `options.agentEngine` is set, respect the user choice.
    const requested = options.agentEngine;
    const engine = requested
      ? this.resolveEngineForOptions(requested)
      : this.resolveEngineForOptions(inferEngineFromQuery(prompt, this.safeResolveEngine()).engine);
    // Drop any skill IDs that aren't on disk before they reach the runtime
    // adapter; otherwise the SDK will invent tools the host cannot resolve.
    const filteredSkillIds = options.skillIds?.filter((id) => isAllowedSkill(id));
    const cleanedOptions: CoworkStartOptions = filteredSkillIds
      ? { ...options, skillIds: filteredSkillIds }
      : options;
    this.sessionEngine.set(sessionId, engine);
    this.telemetryTracker?.startTurn(sessionId, prompt, engine, cleanedOptions);
    try {
      await this.runtimeByEngine[engine].startSession(sessionId, prompt, cleanedOptions);
    } catch (error) {
      this.telemetryTracker?.finishTurn(
        sessionId,
        RuntimeCallStatus.Error,
        error instanceof Error ? error.message : String(error),
      );
      this.sessionEngine.delete(sessionId);
      this.clearRequestEngineBySession(sessionId);
      throw error;
    }
  }

  async continueSession(sessionId: string, prompt: string, options: CoworkContinueOptions = {}): Promise<void> {
    const requested = options.agentEngine;
    const engine = requested
      ? this.resolveEngineForOptions(requested)
      : this.resolveEngineForOptions(inferEngineFromQuery(prompt, this.safeResolveEngine()).engine);
    const filteredSkillIds = options.skillIds?.filter((id) => isAllowedSkill(id));
    const cleanedOptions: CoworkContinueOptions = filteredSkillIds
      ? { ...options, skillIds: filteredSkillIds }
      : options;
    this.sessionEngine.set(sessionId, engine);
    this.telemetryTracker?.startTurn(sessionId, prompt, engine, cleanedOptions);
    try {
      await this.runtimeByEngine[engine].continueSession(sessionId, prompt, cleanedOptions);
    } catch (error) {
      this.telemetryTracker?.finishTurn(
        sessionId,
        RuntimeCallStatus.Error,
        error instanceof Error ? error.message : String(error),
      );
      this.sessionEngine.delete(sessionId);
      this.clearRequestEngineBySession(sessionId);
      throw error;
    }
  }

  stopSession(sessionId: string): void {
    const engine = this.sessionEngine.get(sessionId);
    if (engine) {
      this.runtimeByEngine[engine].stopSession(sessionId);
    } else {
      for (const runtime of Object.values(this.runtimeByEngine)) {
        runtime.stopSession(sessionId);
      }
    }
    this.sessionEngine.delete(sessionId);
    this.clearRequestEngineBySession(sessionId);
  }

  stopAllSessions(): void {
    for (const runtime of Object.values(this.runtimeByEngine)) {
      runtime.stopAllSessions();
    }
    this.sessionEngine.clear();
    this.requestEngine.clear();
    this.requestSession.clear();
  }

  respondToPermission(requestId: string, result: PermissionResult): void {
    const engine = this.requestEngine.get(requestId);
    if (engine) {
      this.runtimeByEngine[engine].respondToPermission(requestId, result);
      if (result.behavior === 'allow' || result.behavior === 'deny') {
        this.requestEngine.delete(requestId);
        this.requestSession.delete(requestId);
      }
      return;
    }

    for (const runtime of Object.values(this.runtimeByEngine)) {
      runtime.respondToPermission(requestId, result);
    }
  }

  isSessionActive(sessionId: string): boolean {
    const engine = this.sessionEngine.get(sessionId);
    if (engine) {
      return this.runtimeByEngine[engine].isSessionActive(sessionId);
    }
    return Object.values(this.runtimeByEngine)
      .some((runtime) => runtime.isSessionActive(sessionId));
  }

  getSessionConfirmationMode(sessionId: string): 'modal' | 'text' | null {
    const engine = this.sessionEngine.get(sessionId);
    if (engine) {
      return this.runtimeByEngine[engine].getSessionConfirmationMode(sessionId);
    }
    for (const runtime of Object.values(this.runtimeByEngine)) {
      const mode = runtime.getSessionConfirmationMode(sessionId);
      if (mode) return mode;
    }
    return null;
  }

  onSessionDeleted(sessionId: string): void {
    this.sessionEngine.delete(sessionId);
    this.clearRequestEngineBySession(sessionId);
    for (const runtime of Object.values(this.runtimeByEngine)) {
      runtime.onSessionDeleted?.(sessionId);
    }
  }

  handleEngineConfigChanged(nextEngine: CoworkAgentEngine): void {
    if (nextEngine === this.currentEngine) {
      return;
    }

    this.currentEngine = nextEngine;
    // Only stop sessions that the *user is currently in* and that belong to
    // a different engine. The runtime adapters themselves are kept alive so
    // their gateway processes and warm caches survive the switch — the user
    // pays for the new engine's first call only, not every other engine's
    // shutdown cost.
    const activeSessionIds = Array.from(this.sessionEngine.keys())
      .filter((sessionId) => {
        const engine = this.sessionEngine.get(sessionId);
        return Boolean(engine) && Object.values(this.runtimeByEngine)
          .some((runtime) => runtime.isSessionActive(sessionId));
      });
    this.stopAllSessions();

    activeSessionIds.forEach((sessionId) => {
      this.emit('error', sessionId, ENGINE_SWITCHED_CODE);
    });
  }

  private bindRuntimeEvents(engine: CoworkAgentEngine, runtime: CoworkRuntime): void {
    runtime.on('message', (sessionId, message) => {
      this.sessionEngine.set(sessionId, engine);
      this.telemetryTracker?.recordMessage(sessionId, message);
      this.emit('message', sessionId, message);
    });

    runtime.on('messageUpdate', (sessionId, messageId, content) => {
      this.sessionEngine.set(sessionId, engine);
      this.telemetryTracker?.recordMessageUpdate(sessionId, messageId, content);
      this.emit('messageUpdate', sessionId, messageId, content);
    });

    runtime.on('permissionRequest', (sessionId, request) => {
      this.sessionEngine.set(sessionId, engine);
      this.requestEngine.set(request.requestId, engine);
      this.requestSession.set(request.requestId, sessionId);
      this.emit('permissionRequest', sessionId, request);
    });

    runtime.on('runtimeMetric', (sessionId, metric) => {
      this.sessionEngine.set(sessionId, engine);
      this.telemetryTracker?.recordRuntimeMetric(sessionId, metric);
      this.emit('runtimeMetric', sessionId, metric);
    });

    runtime.on('complete', (sessionId, claudeSessionId) => {
      this.telemetryTracker?.finishTurn(sessionId, RuntimeCallStatus.Completed);
      this.sessionEngine.delete(sessionId);
      this.clearRequestEngineBySession(sessionId);
      this.emit('complete', sessionId, claudeSessionId);
    });

    runtime.on('error', (sessionId, error) => {
      this.telemetryTracker?.finishTurn(sessionId, RuntimeCallStatus.Error, error);
      this.sessionEngine.delete(sessionId);
      this.clearRequestEngineBySession(sessionId);
      this.emit('error', sessionId, error);
    });

    runtime.on('sessionStopped', (sessionId) => {
      this.telemetryTracker?.finishTurn(sessionId, RuntimeCallStatus.Stopped);
      this.sessionEngine.delete(sessionId);
      this.clearRequestEngineBySession(sessionId);
      this.emit('sessionStopped', sessionId);
    });
  }

  private clearRequestEngineBySession(sessionId: string): void {
    for (const [requestId, requestSessionId] of this.requestSession.entries()) {
      if (requestSessionId !== sessionId) continue;
      this.requestSession.delete(requestId);
      this.requestEngine.delete(requestId);
    }
  }

  private safeResolveEngine(): CoworkAgentEngine {
    const nextEngine = this.getCurrentEngine();
    if (isCoworkAgentEngine(nextEngine)) {
      this.currentEngine = nextEngine;
      return nextEngine;
    }
    this.currentEngine = CoworkAgentEngineValue.YdCowork;
    return CoworkAgentEngineValue.YdCowork;
  }

  private resolveEngineForOptions(engine: CoworkAgentEngine | undefined): CoworkAgentEngine {
    if (isCoworkAgentEngine(engine)) {
      this.currentEngine = engine;
      return engine;
    }
    return this.safeResolveEngine();
  }
}
