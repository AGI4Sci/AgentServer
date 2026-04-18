import { z } from 'zod';

export const appSchemaPatchSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('APP_SCHEMA_PATCH'),
    reason: z.string(),
    operations: z.array(z.object({
      op: z.enum(['replace', 'add', 'remove']),
      path: z.string(),
      value: z.any().optional(),
    })),
  }),
  z.object({
    type: z.literal('PAGE_ADD'),
    reason: z.string(),
    page: z.object({
      id: z.string(),
      name: z.string(),
      title: z.string(),
      path: z.string(),
    }),
  }),
  z.object({
    type: z.literal('COMPONENT_MOVE'),
    reason: z.string(),
    pageId: z.string(),
    nodeId: z.string(),
    fromParentId: z.string(),
    toParentId: z.string(),
    position: z.number().int().min(0),
  }),
  z.object({
    type: z.literal('BINDING_UPDATE'),
    reason: z.string(),
    pageId: z.string(),
    nodeId: z.string(),
    bindingKey: z.string(),
    source: z.string(),
    path: z.string(),
  }),
  z.object({
    type: z.literal('WORKFLOW_PATCH'),
    reason: z.string(),
    workflowId: z.string(),
    operations: z.array(z.object({
      op: z.enum(['replace', 'add', 'remove']),
      path: z.string(),
      value: z.any().optional(),
    })),
  }),
]);

export type AppSchemaPatch = z.infer<typeof appSchemaPatchSchema>;
