import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../errors';
import { charLimitForTier, normalizeAccountTier } from '../lib/accountTier';
import { db } from '../data';
import {
  consumeOAuthState,
  createAuthorization,
  createOAuthStateRow,
  disconnectAccount,
  exchangeAuthorizationCode,
  postTestTweet,
  publicAccount,
  refreshAccountTier,
  saveConnectedAccount,
} from '../lib/xOAuth';
import { parse, requireUser, uid, wrap } from './util';
import { config } from '../config';

export const authX = Router();

function frontendResult(success: boolean, message?: string): string {
  const url = new URL(config.frontendUrl);
  // Land on the paid-only Connect X step so OAuth return continues the post-welcome flow.
  url.pathname = '/connect-x';
  url.searchParams.set('x_connection', success ? 'success' : 'error');
  if (message) url.searchParams.set('x_message', message);
  return url.toString();
}

authX.get('/connect', requireUser, wrap(async (req, res) => {
  const authorization = createAuthorization();
  await createOAuthStateRow(uid(req), authorization.state, authorization.verifier, authorization.expiresAt);
  const url = new URL('https://x.com/i/oauth2/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', authorization.clientId);
  url.searchParams.set('redirect_uri', authorization.redirectUri);
  url.searchParams.set('scope', 'tweet.read tweet.write users.read offline.access');
  url.searchParams.set('state', authorization.state);
  url.searchParams.set('code_challenge', authorization.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  res.json({ authorize_url: url.toString() });
}));

authX.get('/callback', wrap(async (req, res) => {
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const pending = state ? await consumeOAuthState(state) : null;
  if (!pending) {
    res.redirect(303, frontendResult(false, 'X authorization state is missing, invalid, or expired. Please reconnect.'));
    return;
  }

  if (typeof req.query.error === 'string') {
    const denied = req.query.error === 'access_denied';
    res.redirect(303, frontendResult(false, denied
      ? 'X authorization was cancelled. No account was connected.'
      : 'X could not authorize the connection. Please try again.'));
    return;
  }
  if (typeof req.query.code !== 'string' || !req.query.code) {
    res.redirect(303, frontendResult(false, 'X did not return an authorization code. Please try again.'));
    return;
  }

  try {
    const tokens = await exchangeAuthorizationCode(req.query.code, pending.code_verifier);
    await saveConnectedAccount(pending.user_id, tokens);
    res.redirect(303, frontendResult(true, 'X account connected.'));
  } catch (error) {
    const message = error instanceof AppError ? error.message : 'X connection failed. Please try again.';
    console.error(`[X OAuth callback] ${message}`);
    res.redirect(303, frontendResult(false, message));
  }
}));

authX.get('/status', requireUser, wrap(async (req, res) => {
  const account = await publicAccount(uid(req));
  // Re-check Free/Premium when an X account is connected (throttled inside refreshAccountTier).
  if (account?.status === 'connected') {
    await refreshAccountTier(uid(req));
  }
  const user = await db.get('users', (row) => row.id === uid(req));
  res.json({
    connected: account?.status === 'connected',
    account,
    account_tier: normalizeAccountTier(user?.account_tier),
    tier_source: user?.tier_source === 'api' || user?.tier_source === 'manual' ? user.tier_source : 'fallback',
  });
}));

authX.post('/disconnect', requireUser, wrap(async (req, res) => {
  await disconnectAccount(uid(req));
  res.json({ disconnected: true });
}));

authX.post('/test-tweet', requireUser, wrap(async (req, res) => {
  const user = await db.get('users', (row) => row.id === uid(req));
  const max = charLimitForTier(user?.account_tier);
  const { text } = parse(z.object({ text: z.string().trim().min(1).max(max) }), req.body);
  res.status(201).json(await postTestTweet(uid(req), text));
}));
