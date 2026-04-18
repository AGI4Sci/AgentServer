import { z } from 'zod';

export const templatePackSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  category: z.enum(['landing', 'dashboard', 'workflow', 'form', 'data']),
  entryTemplateId: z.string(),
  templates: z.array(z.object({
    id: z.string(),
    name: z.string(),
    summary: z.string(),
    appSchemaSeedPath: z.string(),
    previewImage: z.string().optional(),
    requiredCapabilities: z.array(z.string()).default([]),
  })),
});

export type TemplatePack = z.infer<typeof templatePackSchema>;

export function createDefaultTemplatePack() {
  return templatePackSchema.parse({
    id: 'template-pack-core',
    name: 'Core Studio Templates',
    description: 'First-party templates for OpenTeam Studio. P2 opens this layer before Agent Pack.',
    version: '0.1.0',
    category: 'workflow',
    entryTemplateId: 'template-agent-workbench',
    templates: [
      {
        id: 'template-agent-workbench',
        name: 'Agent Workbench',
        summary: 'Team UI plus workflow-driven app schema seed.',
        appSchemaSeedPath: 'templates/agent-workbench/app-schema.json',
        requiredCapabilities: ['app-schema', 'workflow-ref', 'preview'],
      },
      {
        id: 'template-landing-starter',
        name: 'Landing Starter',
        summary: 'Marketing-style landing page that still supports workflow references.',
        appSchemaSeedPath: 'templates/landing-starter/app-schema.json',
        requiredCapabilities: ['app-schema', 'preview'],
      },
    ],
  });
}
