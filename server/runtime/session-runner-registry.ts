import {
  BACKEND_CATALOG,
  DEFAULT_BACKEND,
  normalizeBackendType,
  type BackendType,
} from '../../core/runtime/backend-catalog.js';
import { getTeamRegistry } from '../../core/team/registry.js';
import type { TeamRuntimeConfig } from '../../core/team/types.js';
import { ClaudeCodeSessionClient } from './clients/claude-code-session-client.js';
import { ClaudeCodeRustSessionClient } from './clients/claude-code-rust-session-client.js';
import { CodexSessionClient } from './clients/codex-session-client.js';
import { HermesAgentSessionClient } from './clients/hermes-agent-session-client.js';
import { OpenClawSessionClient } from './clients/openclaw-session-client.js';
import { ZeroClawSessionClient } from './clients/zeroclaw-session-client.js';
import type { SessionClientType, SessionRunner } from './session-types.js';

const RUNNER_REGISTRY: Record<BackendType, SessionRunner> = {
  'claude-code': new ClaudeCodeSessionClient(),
  'claude-code-rust': new ClaudeCodeRustSessionClient(),
  codex: new CodexSessionClient(),
  'hermes-agent': new HermesAgentSessionClient(),
  openclaw: new OpenClawSessionClient(),
  zeroclaw: new ZeroClawSessionClient(),
};

export function resolveRuntimeBackend(
  runtime: TeamRuntimeConfig | undefined,
  override?: SessionClientType,
): SessionClientType {
  return normalizeBackendType(override ?? runtime?.backend ?? runtime?.type, DEFAULT_BACKEND);
}

export function resolveSessionClientType(
  teamRuntimeType: SessionClientType | undefined,
  override: SessionClientType | undefined,
): SessionClientType {
  return normalizeBackendType(override ?? teamRuntimeType, DEFAULT_BACKEND);
}

export function resolveTeamSessionClientType(
  teamId: string,
  override?: SessionClientType,
): SessionClientType {
  const registry = getTeamRegistry(teamId);
  return resolveRuntimeBackend(registry?.raw.runtime, override);
}

export function listSupportedBackends(): BackendType[] {
  return BACKEND_CATALOG.map((item) => item.id);
}

export function getSessionRunner(clientType: SessionClientType): SessionRunner {
  const runner = RUNNER_REGISTRY[clientType];
  if (runner) {
    return runner;
  }
  throw new Error(`Session runner not implemented for client: ${clientType}`);
}
