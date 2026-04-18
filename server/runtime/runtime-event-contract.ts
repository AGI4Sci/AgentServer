import type { SessionStreamEvent } from './session-types.js';
import type { WorkerEvent } from './team-worker-types.js';

export const RUNTIME_EVENT_PROTOCOL_VERSION = 'v1' as const;

export type RuntimeEventProtocolVersion = typeof RUNTIME_EVENT_PROTOCOL_VERSION;

export interface RuntimeEventProtocolEnvelope {
  protocolVersion: RuntimeEventProtocolVersion;
}

export function withRuntimeEventProtocol<T extends { protocolVersion?: RuntimeEventProtocolVersion }>(
  event: T,
): T & RuntimeEventProtocolEnvelope {
  return {
    protocolVersion: RUNTIME_EVENT_PROTOCOL_VERSION,
    ...event,
  };
}

export function normalizeSessionStreamEvent(event: SessionStreamEvent): SessionStreamEvent {
  return withRuntimeEventProtocol(event);
}

export function normalizeWorkerEvent(event: WorkerEvent): WorkerEvent {
  return withRuntimeEventProtocol(event);
}
