import { z } from 'zod';

export const appNodeBindingSchema = z.object({
  source: z.string(),
  path: z.string(),
});

export const appActionSchema = z.object({
  id: z.string(),
  type: z.enum(['navigate', 'submit', 'mutation', 'workflow', 'custom']),
  label: z.string().optional(),
  target: z.string().optional(),
  workflowId: z.string().optional(),
  successNodeId: z.string().optional(),
  payload: z.record(z.any()).optional(),
});

export const workflowStepSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.string(),
  agentRole: z.string().optional(),
  next: z.array(z.string()).default([]),
});

export const appWorkflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['team', 'agent', 'app']),
  trigger: z.enum(['manual', 'page-action', 'system']).default('manual'),
  entryActionId: z.string().optional(),
  steps: z.array(workflowStepSchema).default([]),
});

export const componentNodeSchema = z.object({
  id: z.string(),
  type: z.string(),
  label: z.string().optional(),
  props: z.record(z.any()).default({}),
  bindings: z.record(appNodeBindingSchema).default({}),
  actions: z.array(appActionSchema).default([]),
  children: z.array(z.string()).default([]),
});

export const appPageSchema = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string(),
  path: z.string(),
  rootNodeId: z.string(),
  nodes: z.record(componentNodeSchema),
});

export const appSchemaSchema = z.object({
  version: z.literal('1.0'),
  projectId: z.string(),
  pages: z.array(appPageSchema),
  dataSources: z.array(z.object({
    id: z.string(),
    type: z.enum(['static', 'http', 'workspace', 'agent-output']),
    label: z.string(),
    config: z.record(z.any()).default({}),
  })).default([]),
  workflows: z.array(appWorkflowSchema).default([]),
  updatedAt: z.string(),
});

export const appProjectSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  name: z.string(),
  description: z.string().default(''),
  status: z.enum(['draft', 'preview-ready', 'published']).default('draft'),
  schemaVersion: z.literal('1.0'),
  schemaPath: z.string(),
  previewSessionId: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const previewSessionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  teamId: z.string(),
  status: z.enum(['idle', 'building', 'ready', 'failed']).default('idle'),
  previewUrl: z.string().nullable().default(null),
  lastBuildAt: z.string().nullable().default(null),
  buildLogs: z.array(z.string()).default([]),
});

export type AppProject = z.infer<typeof appProjectSchema>;
export type AppSchema = z.infer<typeof appSchemaSchema>;
export type PreviewSession = z.infer<typeof previewSessionSchema>;

export function createDefaultAppSchema(projectId: string, projectName: string): AppSchema {
  const rootNodeId = 'node-root';
  const heroNodeId = 'node-hero';
  const now = new Date().toISOString();

  return appSchemaSchema.parse({
    version: '1.0',
    projectId,
    pages: [
      {
        id: 'page-home',
        name: 'home',
        title: projectName,
        path: '/',
        rootNodeId,
        nodes: {
          [rootNodeId]: {
            id: rootNodeId,
            type: 'page',
            label: 'Home Page',
            props: {
              layout: 'stack',
            },
            children: [heroNodeId],
          },
          [heroNodeId]: {
            id: heroNodeId,
            type: 'hero',
            label: 'Hero',
            props: {
              headline: projectName,
              body: 'Describe what this team project should become. This schema will later drive the App Studio canvas.',
              ctaLabel: 'Start Editing',
            },
            actions: [
              {
                id: 'action-start-design',
                type: 'workflow',
                label: 'Start Editing',
                workflowId: 'workflow-design-loop',
                successNodeId: heroNodeId,
              },
            ],
            children: [],
          },
        },
      },
    ],
    dataSources: [],
    workflows: [
      {
        id: 'workflow-design-loop',
        name: 'Design Loop',
        kind: 'team',
        trigger: 'page-action',
        entryActionId: 'action-start-design',
        steps: [
          {
            id: 'step-intake',
            label: 'Clarify Goal',
            type: 'prompt',
            agentRole: 'pm',
            next: ['step-design'],
          },
          {
            id: 'step-design',
            label: 'Generate UI + Workflow Patch',
            type: 'schema-patch',
            agentRole: 'designer',
            next: ['step-review'],
          },
          {
            id: 'step-review',
            label: 'Review and Preview',
            type: 'preview',
            agentRole: 'reviewer',
            next: [],
          },
        ],
      },
    ],
    updatedAt: now,
  });
}

export function createDefaultPreviewSession(projectId: string, teamId: string): PreviewSession {
  return previewSessionSchema.parse({
    id: `preview-${projectId}`,
    projectId,
    teamId,
    status: 'idle',
    previewUrl: null,
    lastBuildAt: null,
    buildLogs: [],
  });
}

export function createDefaultAppProject(input: {
  id: string;
  teamId: string;
  name: string;
  description?: string;
  schemaPath?: string;
}): AppProject {
  const now = new Date().toISOString();
  return appProjectSchema.parse({
    id: input.id,
    teamId: input.teamId,
    name: input.name,
    description: input.description ?? '',
    status: 'draft',
    schemaVersion: '1.0',
    schemaPath: input.schemaPath ?? 'app-schema.json',
    previewSessionId: null,
    createdAt: now,
    updatedAt: now,
  });
}
