import { z } from 'zod';

const semverSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const componentSchema = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1),
    required: z.boolean(),
  })
  .strict();

const fileSchema = z
  .object({
    path: z.string().min(1),
    size: z.number().int().nonnegative(),
    sha256: sha256Schema,
  })
  .strict();

export const releaseManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    release: semverSchema,
    createdAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'Expected ISO-8601 timestamp'),
    compatibility: z
      .object({
        cli: z
          .object({
            minVersion: semverSchema,
            maxVersionExclusive: semverSchema.nullable(),
          })
          .strict(),
        hostApi: z
          .object({
            minVersion: z.number().int().positive(),
            maxVersion: z.number().int().positive(),
          })
          .strict(),
        projectSchema: z
          .object({
            supported: z.array(z.number().int().nonnegative()),
            target: z.number().int().nonnegative(),
            migrateFrom: z.array(z.number().int().nonnegative()),
          })
          .strict(),
      })
      .strict(),
    entrypoints: z
      .object({
        core: z.string().min(1),
      })
      .strict(),
    components: z.array(componentSchema),
    files: z.array(fileSchema),
  })
  .strict();

export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

export interface VerifiedReleaseTree {
  root: string;
  digest: string;
  manifest: ReleaseManifest;
}
