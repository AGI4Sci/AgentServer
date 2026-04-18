import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import { error, sendJson, success } from '../../utils/response.js';
import { buildPreviewHtml, buildReadyPreviewSession } from '../../../core/schema/index.js';
import { getProjectMetaPaths, readStructuredProject } from './projects.js';

export async function handleBuildProjectPreview(
  _req: IncomingMessage,
  res: ServerResponse,
  teamId: string,
  projectId: string,
): Promise<void> {
  try {
    const project = readStructuredProject(teamId, projectId);
    if (!project) {
      sendJson(res, 404, error('Project not found'));
      return;
    }

    const paths = getProjectMetaPaths(teamId, projectId);
    const generatedDir = `${paths.projectDir}/generated`;
    if (!existsSync(generatedDir)) {
      mkdirSync(generatedDir, { recursive: true });
    }

    const currentPreview = JSON.parse(readFileSync(paths.previewSessionPath, 'utf-8'));
    const previewUrl = `/teams/${teamId}/projects/${projectId}/generated/index.html`;
    const html = buildPreviewHtml(project, project.schema);
    const previewSession = buildReadyPreviewSession(currentPreview, previewUrl);

    writeFileSync(`${generatedDir}/index.html`, html, 'utf-8');
    writeFileSync(paths.previewSessionPath, JSON.stringify(previewSession, null, 2), 'utf-8');

    sendJson(res, 200, success({
      projectId,
      teamId,
      previewUrl,
      previewSession,
    }));
  } catch (err) {
    console.error('[API] Failed to build project preview:', err);
    sendJson(res, 500, error(String(err)));
  }
}
