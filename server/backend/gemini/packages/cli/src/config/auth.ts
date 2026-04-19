/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@google/gemini-cli-core';
import { loadEnvironment, loadSettings } from './settings.js';

export function validateAuthMethod(authMethod: string): string | null {
  loadEnvironment(loadSettings().merged, process.cwd());
  applyAgentServerAuthEnvAliases();
  if (
    authMethod === AuthType.LOGIN_WITH_GOOGLE ||
    authMethod === AuthType.COMPUTE_ADC
  ) {
    return null;
  }

  if (authMethod === AuthType.USE_GEMINI) {
    if (!process.env['GEMINI_API_KEY']) {
      return (
        'When using Gemini API, you must specify the GEMINI_API_KEY environment variable.\n' +
        'Update your environment and try again (no reload needed if using .env)!'
      );
    }
    return null;
  }

  if (authMethod === AuthType.USE_VERTEX_AI) {
    const hasVertexProjectLocationConfig =
      !!process.env['GOOGLE_CLOUD_PROJECT'] &&
      !!process.env['GOOGLE_CLOUD_LOCATION'];
    const hasGoogleApiKey = !!process.env['GOOGLE_API_KEY'];
    if (!hasVertexProjectLocationConfig && !hasGoogleApiKey) {
      return (
        'When using Vertex AI, you must specify either:\n' +
        '• GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION environment variables.\n' +
        '• GOOGLE_API_KEY environment variable (if using express mode).\n' +
        'Update your environment and try again (no reload needed if using .env)!'
      );
    }
    return null;
  }

  return 'Invalid auth method selected.';
}

function applyAgentServerAuthEnvAliases(): void {
  applyEnvAlias('GEMINI_API_KEY', 'AGENT_SERVER_GEMINI_API_KEY');
  applyEnvAlias('GOOGLE_API_KEY', 'AGENT_SERVER_GOOGLE_API_KEY');
  applyEnvAlias('GOOGLE_APPLICATION_CREDENTIALS', 'AGENT_SERVER_GOOGLE_APPLICATION_CREDENTIALS');
}

function applyEnvAlias(official: string, agentServer: string): void {
  const current = process.env[official]?.trim();
  if (current && !isPlaceholderValue(current)) {
    return;
  }
  const value = process.env[agentServer]?.trim();
  if (value && !isPlaceholderValue(value)) {
    process.env[official] = value;
  }
}

function isPlaceholderValue(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return Boolean(normalized && (
    normalized.startsWith('replace-with-')
    || normalized.includes('<key>')
    || normalized.includes('your-api-key')
  ));
}
