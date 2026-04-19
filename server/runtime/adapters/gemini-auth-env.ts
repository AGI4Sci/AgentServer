import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type MutableEnv = NodeJS.ProcessEnv;

export type GeminiAuthInputSummary = {
  ready: boolean;
  detail: string;
};

const GEMINI_AUTH_ALIASES: Array<[official: string, agentServer: string]> = [
  ['GEMINI_API_KEY', 'AGENT_SERVER_GEMINI_API_KEY'],
  ['GOOGLE_API_KEY', 'AGENT_SERVER_GOOGLE_API_KEY'],
  ['GOOGLE_APPLICATION_CREDENTIALS', 'AGENT_SERVER_GOOGLE_APPLICATION_CREDENTIALS'],
  ['GEMINI_CLI_HOME', 'AGENT_SERVER_GEMINI_CLI_HOME'],
];

export function applyGeminiAuthEnvAliases(env: MutableEnv = process.env): void {
  for (const [official, agentServer] of GEMINI_AUTH_ALIASES) {
    const current = env[official]?.trim();
    if (current && !isPlaceholderValue(current)) {
      continue;
    }
    const value = env[agentServer]?.trim();
    if (value && !isPlaceholderValue(value)) {
      env[official] = value;
    }
  }
}

export function summarizeGeminiAuthInputs(env: NodeJS.ProcessEnv = process.env): GeminiAuthInputSummary {
  applyGeminiAuthEnvAliases(env);
  const rawGeminiApiKey = env.GEMINI_API_KEY?.trim();
  const rawGoogleApiKey = env.GOOGLE_API_KEY?.trim();
  const rawAgentServerGeminiApiKey = env.AGENT_SERVER_GEMINI_API_KEY?.trim();
  const rawAgentServerGoogleApiKey = env.AGENT_SERVER_GOOGLE_API_KEY?.trim();
  const geminiApiKey = Boolean(rawGeminiApiKey && !isPlaceholderValue(rawGeminiApiKey));
  const googleApiKey = Boolean(rawGoogleApiKey && !isPlaceholderValue(rawGoogleApiKey));
  const googleCredentialsPath = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  const googleCredentialsExists = Boolean(
    googleCredentialsPath
      && !isPlaceholderValue(googleCredentialsPath)
      && existsSync(googleCredentialsPath),
  );
  const geminiCliHome = env.GEMINI_CLI_HOME?.trim() || homedir();
  const oauthPath = join(geminiCliHome, '.gemini', 'oauth_creds.json');
  const oauthFileExists = existsSync(oauthPath);
  return {
    ready: geminiApiKey || googleApiKey || googleCredentialsExists || oauthFileExists,
    detail: [
      `AGENT_SERVER_GEMINI_API_KEY=${formatAuthInputStatus(rawAgentServerGeminiApiKey, Boolean(rawAgentServerGeminiApiKey && !isPlaceholderValue(rawAgentServerGeminiApiKey)))}`,
      `AGENT_SERVER_GOOGLE_API_KEY=${formatAuthInputStatus(rawAgentServerGoogleApiKey, Boolean(rawAgentServerGoogleApiKey && !isPlaceholderValue(rawAgentServerGoogleApiKey)))}`,
      `GEMINI_API_KEY=${formatAuthInputStatus(rawGeminiApiKey, geminiApiKey)}`,
      `GOOGLE_API_KEY=${formatAuthInputStatus(rawGoogleApiKey, googleApiKey)}`,
      `GOOGLE_APPLICATION_CREDENTIALS=${formatPathInputStatus(googleCredentialsPath, googleCredentialsExists)}`,
      `oauthFile=${oauthFileExists ? 'exists' : 'missing'}:${oauthPath}`,
      'Set one Gemini/Google auth source before running Gemini live smoke.',
    ].join(' '),
  };
}

function isPlaceholderValue(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return Boolean(normalized && (
    normalized.startsWith('replace-with-')
    || normalized.includes('<key>')
    || normalized.includes('<model>')
    || normalized.includes('your-api-key')
    || normalized.includes('your-model')
  ));
}

function formatAuthInputStatus(value: string | undefined, valid: boolean): string {
  if (valid) {
    return 'set';
  }
  return isPlaceholderValue(value) ? 'placeholder' : 'missing';
}

function formatPathInputStatus(value: string | undefined, exists: boolean): string {
  if (!value) {
    return 'missing';
  }
  if (isPlaceholderValue(value)) {
    return 'placeholder';
  }
  return exists ? 'exists' : 'missing-file';
}
