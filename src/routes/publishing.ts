import { Router } from 'express';
import { z } from 'zod';
import { db } from '../data';
import { assertPaid } from '../lib/gates';
import { parse, requireOnboarded, requireUser, uid, wrap } from './util';

export const publishing = Router();
publishing.use(requireUser);
publishing.use(requireOnboarded);

const DEFAULT_TIMES = [
  ['08:15', '18:30'],
  ['07:45', '12:30', '17:15'],
  ['08:00', '13:00'],
  ['07:45', '11:30', '16:45'],
  ['09:00', '14:15'],
  ['07:30', '15:00'],
  ['10:00', '13:30'],
];

const SlotsBody = z.object({
  slots: z.array(z.object({
    dayOfWeek: z.number().int().min(0).max(6),
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'use HH:mm 24-hour time'),
    enabled: z.boolean(),
  })).max(100),
});

function defaultSlots() {
  return DEFAULT_TIMES.flatMap((times, dayOfWeek) => times.map((time) => ({
    id: `default-${dayOfWeek}-${time.replace(':', '')}`,
    dayOfWeek,
    time,
    enabled: dayOfWeek !== 0 && dayOfWeek !== 6,
  })));
}

publishing.get(
  '/slots',
  wrap(async (req, res) => {
    const user = await db.get('users', (u) => u.id === uid(req));
    const slots = Array.isArray(user?.posting_slots) && user!.posting_slots.length ? user!.posting_slots : defaultSlots();
    res.json({ slots, timezone: user?.timezone ?? 'UTC' });
  }),
);

publishing.put(
  '/slots',
  wrap(async (req, res) => {
    await assertPaid(uid(req), 'posting schedule changes');
    const { slots } = parse(SlotsBody, req.body);
    const userId = uid(req);
    await db.update('users', (u) => u.id === userId, {
      posting_slots: slots.map((slot) => ({
        id: `${slot.dayOfWeek}-${slot.time.replace(':', '')}`,
        ...slot,
      })),
    });
    const user = await db.get('users', (u) => u.id === userId);
    res.json({ slots: user?.posting_slots ?? [], timezone: user?.timezone ?? 'UTC' });
  }),
);
