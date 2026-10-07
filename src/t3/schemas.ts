import * as z from 'zod';

/** The fields of `t3_environment_read` the gateway relies on. Extra fields are kept, not validated. */
export const environmentSchema = z.looseObject({
  environmentId: z.string(),
  serverVersion: z.string(),
  platform: z.looseObject({ os: z.string(), arch: z.string() }),
});
export type T3Environment = z.infer<typeof environmentSchema>;

export const projectSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  deletedAt: z.string().nullable().optional(),
});
export type T3Project = z.infer<typeof projectSchema>;

export const projectListSchema = z.looseObject({
  projects: z.array(projectSchema),
  nextCursor: z.number().int().nullable().optional(),
});
