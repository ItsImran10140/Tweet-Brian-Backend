import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../errors';
import { db } from '../data';
import {
  insertExperienceItem,
  searchExperienceItems,
  type ExperienceKind,
} from '../lib/experienceBank';
import { idParam, parse, requireOnboarded, requireUser, uid, wrap } from './util';

export const experience = Router();
experience.use(requireUser);
experience.use(requireOnboarded);

const KINDS = ['story', 'opinion', 'number', 'hate', 'moment', 'daily'] as const;

const CreateBody = z.object({
  kind: z.enum(KINDS),
  text: z.string().min(1).max(2000),
  tags: z.array(z.string().max(40)).max(12).optional(),
});

const ListQuery = z.object({
  q: z.string().max(200).optional(),
  kind: z.enum(KINDS).optional(),
  tag: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

experience.get(
  '/',
  wrap(async (req, res) => {
    const q = parse(ListQuery, {
      q: typeof req.query.q === 'string' ? req.query.q : undefined,
      kind: typeof req.query.kind === 'string' ? req.query.kind : undefined,
      tag: typeof req.query.tag === 'string' ? req.query.tag : undefined,
      limit: req.query.limit,
    });
    const items = await searchExperienceItems(uid(req), q);
    res.json({ items });
  }),
);

experience.post(
  '/',
  wrap(async (req, res) => {
    const body = parse(CreateBody, req.body);
    const row = await insertExperienceItem(uid(req), {
      kind: body.kind as ExperienceKind,
      text: body.text,
      tags: body.tags,
      source: 'manual',
    });
    if (!row) throw new AppError(400, 'empty_text', 'Text is required.');
    res.status(201).json(row);
  }),
);

experience.delete(
  '/:id',
  wrap(async (req, res) => {
    const id = idParam(req);
    const userId = uid(req);
    const existing = await db.get('experience_items', (r) => r.id === id && r.user_id === userId);
    if (!existing) throw new AppError(404, 'not_found', 'Experience item not found.');
    await db.remove('experience_items', (r) => r.id === id && r.user_id === userId);
    res.json({ ok: true, id });
  }),
);
