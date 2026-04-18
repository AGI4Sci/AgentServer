import type { AgentStatus, MessageMetadata } from '../../core/types/index.js';

export interface AgentResponse {
  type:
    | 'agent-stream'
    | 'agent-reply'
    | 'agent-thinking'
    | 'agent-status'
    | 'agent-error'
    | 'runtime-tool-call'
    | 'runtime-permission-request';
  sessionKey?: string;
  from?: string;
  to?: string;
  body?: string;
  isFinal?: boolean;
  thinking?: string;
  status?: AgentStatus | string;
  error?: string;
  metadata?: MessageMetadata;
  timestamp: string;
}
