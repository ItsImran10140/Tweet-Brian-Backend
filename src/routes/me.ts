import { Router } from 'express';
import { buildWhoAmI } from '../lib/auth';
import type { AuthedRequest } from './util';
import { wrap } from './util';

/** Who am I — state is always computed from the database. */
export const me = Router();

me.get(
  '/',
  wrap(async (req, res) => {
    const user = (req as AuthedRequest).authUser;
    res.json(await buildWhoAmI(user));
  }),
);
