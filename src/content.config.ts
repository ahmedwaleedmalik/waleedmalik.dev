import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    canonical: z.string().optional(),
    tags: z.array(z.string()).default([]),
    heroImage: z.string().optional(),
    presentation: z.enum(['standard', 'feature']).default('standard'),
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
