import { existsSync } from 'fs';
import { join } from 'path';
import { listBackendExecutableNames, type BackendType } from '../../../core/runtime/backend-catalog.js';

function executableSuffix(): string {
  return process.platform === 'win32' ? '.exe' : '';
}

export function getManagedBackendBinDir(): string {
  return process.env.OPENTEAM_BACKEND_BIN_DIR?.trim()
    || join(process.cwd(), 'server', 'backend', 'bin');
}

export function getManagedBackendExecutablePath(name: string): string {
  const suffix = name.includes('.') ? '' : executableSuffix();
  return join(getManagedBackendBinDir(), `${name}${suffix}`);
}

export function resolveManagedBackendExecutable(name: string): string | null {
  const candidate = getManagedBackendExecutablePath(name);
  return existsSync(candidate) ? candidate : null;
}

export function listManagedBackendExecutableNames(backend: BackendType): readonly string[] {
  return listBackendExecutableNames(backend);
}

export function resolveManagedBackendExecutableForBackend(backend: BackendType): string | null {
  for (const candidate of listManagedBackendExecutableNames(backend)) {
    const resolved = resolveManagedBackendExecutable(candidate);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}
