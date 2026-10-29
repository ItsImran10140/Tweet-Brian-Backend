import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { AppError } from '../errors';
import { config } from '../config';
import {
  normalizeAccountTier,
  normalizeTierSource,
  tierFromSubscriptionType,
  type AccountTier,
  type TierSource,
} from './accountTier';
import { db } from '../data';

const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const X_REVOKE_URL = 'https://api.x.com/2/oauth2/revoke';
const X_API_URL = 'https://api.x.com/2';
const SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'offline.access'];
const ME_USER_FIELDS = 'subscription_type,verified,verified_type,profile_image_url';

export interface SocialAccount {
  id: string;
  user_id: string;
  platform: 'x';
  x_user_id: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
  encrypted_access_token: string;
  encrypted_refresh_token: string;
  expires_at: string;
  scopes: string[];
  status: 'connected' | 'needs_reconnect';
  created_at: string;
  updated_at: string;
}

interface TokenResponse {
  token_type: string;
  expires_in: number;
  access_token: string;
  refresh_token?: string;
  scope?: string;
}

interface XUserResponse {
  data: {
    id: string;
    name: string;
    username: string;
    profile_image_url?: string;
    subscription_type?: string | null;
    verified?: boolean;
    verified_type?: string | null;
  };
}

export interface AccountTierResult {
  account_tier: AccountTier;
  tier_source: TierSource;
}

function configured() {
  const { clientId, clientSecret, redirectUri, tokenEncryptionKey } = config.xOAuth;
  if (!clientId || !clientSecret || !redirectUri || !tokenEncryptionKey) {
    throw new AppError(503, 'x_oauth_not_configured', 'X account connection is not configured.', 'Fill in x_oauth.client_id, client_secret, redirect_uri, and token_encryption_key in config.yml.');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(tokenEncryptionKey)) {
    throw new AppError(500, 'invalid_token_encryption_key', 'The X token encryption key must be exactly 64 hexadecimal characters (32 bytes).');
  }
  return { clientId, clientSecret, redirectUri, key: Buffer.from(tokenEncryptionKey, 'hex') };
}

export function createAuthorization() {
  const { clientId, redirectUri } = configured();
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();

  return { state, verifier, challenge, expiresAt, clientId, redirectUri };
}

export function encryptToken(token: string): string {
  const { key } = configured();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}.${cipher.getAuthTag().toString('hex')}.${ciphertext.toString('hex')}`;
}

export function decryptToken(value: string): string {
  const { key } = configured();
  const [ivHex, tagHex, encryptedHex, ...extra] = value.split('.');
  if (!ivHex || !tagHex || !encryptedHex || extra.length || !/^[0-9a-f]+$/i.test(ivHex + tagHex + encryptedHex)) {
    throw new AppError(500, 'invalid_encrypted_token', 'A stored X token is not in a valid encrypted format.');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new AppError(500, 'token_decryption_failed', 'A stored X token could not be decrypted. Check x_oauth.token_encryption_key.');
  }
}

function clientAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

async function readResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { detail: text.slice(0, 500) };
  }
}

async function fetchX(url: string, init: RequestInit, action: string): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new AppError(502, 'x_unreachable', `Could not reach X to ${action}. Check the server's network connection and try again.`);
  }
}

function xErrorMessage(status: number, payload: Record<string, unknown>, action: string): string {
  if (status === 401) return 'X rejected the authorization. Reconnect your account and try again.';
  if (status === 402) return 'X returned 402: this developer account may have no API credits or the endpoint is not included in its plan.';
  if (status === 429) return 'X rate limit reached. Wait a little while, then try again.';
  const detail = typeof payload.detail === 'string'
    ? payload.detail
    : typeof payload.title === 'string'
      ? payload.title
      : '';
  return detail ? `X could not ${action}: ${detail}` : `X could not ${action} (HTTP ${status}).`;
}

async function requestTokens(body: URLSearchParams): Promise<TokenResponse> {
  const { clientId, clientSecret } = configured();
  const response = await fetchX(X_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: clientAuthHeader(clientId, clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  }, 'exchange or refresh tokens');
  const payload = await readResponse(response);
  if (!response.ok) {
    throw new AppError(response.status, 'x_token_exchange_failed', xErrorMessage(response.status, payload, 'exchange the authorization code'));
  }
  const result = payload as unknown as TokenResponse;
  if (!result.access_token || !Number.isFinite(result.expires_in)) {
    throw new AppError(502, 'invalid_x_token_response', 'X returned an incomplete token response.');
  }
  return result;
}

export async function exchangeAuthorizationCode(code: string, verifier: string): Promise<TokenResponse> {
  const { redirectUri } = configured();
  return requestTokens(new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  }));
}

async function fetchXUser(accessToken: string, fields = ME_USER_FIELDS): Promise<XUserResponse['data']> {
  const response = await fetchX(`${X_API_URL}/users/me?user.fields=${encodeURIComponent(fields)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }, 'fetch the authorized profile');
  const payload = await readResponse(response);
  if (!response.ok) {
    throw new AppError(response.status, 'x_profile_fetch_failed', xErrorMessage(response.status, payload, 'fetch the authorized profile'));
  }
  const user = (payload as unknown as XUserResponse).data;
  if (!user?.id || !user.username || !user.name) {
    throw new AppError(502, 'invalid_x_profile_response', 'X returned an incomplete user profile.');
  }
  return user;
}

/** Prefer subscription fields; if that call fails, load a basic profile (tier falls back). */
async function fetchXUserForConnect(accessToken: string): Promise<XUserResponse['data']> {
  try {
    return await fetchXUser(accessToken, ME_USER_FIELDS);
  } catch {
    return fetchXUser(accessToken, 'profile_image_url');
  }
}

async function applyAccountTier(userId: string, result: AccountTierResult): Promise<void> {
  await db.update('users', (row) => row.id === userId, {
    account_tier: result.account_tier,
    tier_source: result.tier_source,
    tier_checked_at: new Date().toISOString(),
  });
}

/** Persist Free/Premium from an X /users/me payload. Missing subscription_type → free + fallback. */
export async function saveTierFromXUser(userId: string, xUser: { subscription_type?: string | null }): Promise<AccountTierResult> {
  const hasField = Object.prototype.hasOwnProperty.call(xUser, 'subscription_type') && xUser.subscription_type != null;
  if (!hasField) {
    const result: AccountTierResult = { account_tier: 'free', tier_source: 'fallback' };
    await applyAccountTier(userId, result);
    return result;
  }
  const result: AccountTierResult = {
    account_tier: tierFromSubscriptionType(xUser.subscription_type),
    tier_source: 'api',
  };
  await applyAccountTier(userId, result);
  return result;
}

export async function saveFallbackTier(userId: string): Promise<AccountTierResult> {
  const user = await db.get('users', (row) => row.id === userId);
  if (normalizeTierSource(user?.tier_source) === 'manual') {
    return {
      account_tier: normalizeAccountTier(user?.account_tier),
      tier_source: 'manual',
    };
  }
  const result: AccountTierResult = { account_tier: 'free', tier_source: 'fallback' };
  await applyAccountTier(userId, result);
  return result;
}

const TIER_RECHECK_MS = 60 * 60 * 1000; // once per hour counts as a fresh "login" check

/** Re-fetch subscription_type from X and update the user profile. Failures → free + fallback. */
export async function refreshAccountTier(userId: string, opts: { force?: boolean } = {}): Promise<AccountTierResult> {
  const user = await db.get('users', (row) => row.id === userId);
  if (!opts.force && user?.tier_checked_at) {
    const checked = Date.parse(user.tier_checked_at);
    if (Number.isFinite(checked) && Date.now() - checked < TIER_RECHECK_MS) {
      return {
        account_tier: normalizeAccountTier(user.account_tier),
        tier_source: normalizeTierSource(user.tier_source),
      };
    }
  }
  try {
    const { accessToken } = await getValidAccessToken(userId);
    const xUser = await fetchXUserForConnect(accessToken);
    return await saveTierFromXUser(userId, xUser);
  } catch {
    return await saveFallbackTier(userId);
  }
}

export async function saveConnectedAccount(userId: string, tokens: TokenResponse): Promise<void> {
  if (!tokens.refresh_token) {
    throw new AppError(502, 'missing_x_refresh_token', 'X did not return a refresh token.', 'Confirm offline.access is enabled for the X OAuth app.');
  }
  const user = await fetchXUserForConnect(tokens.access_token);
  const now = new Date().toISOString();
  const existing = await db.get('social_accounts', (row) => row.user_id === userId && row.platform === 'x');
  const values = {
    platform: 'x',
    x_user_id: user.id,
    handle: user.username,
    display_name: user.name,
    avatar_url: user.profile_image_url ?? null,
    encrypted_access_token: encryptToken(tokens.access_token),
    encrypted_refresh_token: encryptToken(tokens.refresh_token),
    expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    scopes: tokens.scope?.split(/\s+/).filter(Boolean) ?? SCOPES,
    status: 'connected',
    updated_at: now,
  };
  if (existing) {
    await db.update('social_accounts', (row) => row.id === existing.id, values);
  } else {
    await db.insert('social_accounts', { user_id: userId, ...values });
  }
  await db.update('users', (row) => row.id === userId, { twitter_handle: user.username });
  await saveTierFromXUser(userId, user);
}

export async function publicAccount(userId: string) {
  const row = await db.get('social_accounts', (account) => account.user_id === userId && account.platform === 'x') as SocialAccount | undefined;
  if (!row) return null;
  return {
    id: row.id,
    platform: row.platform,
    x_user_id: row.x_user_id,
    handle: row.handle,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    expires_at: row.expires_at,
    scopes: row.scopes,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function markNeedsReconnect(account: SocialAccount): Promise<void> {
  await db.update('social_accounts', (row) => row.id === account.id, {
    status: 'needs_reconnect',
    updated_at: new Date().toISOString(),
  });
}

export async function getValidAccessToken(userId: string): Promise<{ account: SocialAccount; accessToken: string }> {
  const account = await db.get('social_accounts', (row) => row.user_id === userId && row.platform === 'x') as SocialAccount | undefined;
  if (!account) throw new AppError(404, 'x_account_not_connected', 'No X account is connected.');
  if (account.status !== 'connected') {
    throw new AppError(409, 'x_account_needs_reconnect', 'Reconnect your X account before using it.');
  }

  const expiry = Date.parse(account.expires_at);
  if (Number.isFinite(expiry) && expiry > Date.now() + 5 * 60_000) {
    return { account, accessToken: decryptToken(account.encrypted_access_token) };
  }

  try {
    const refreshToken = decryptToken(account.encrypted_refresh_token);
    if (!refreshToken) throw new Error('Missing X refresh token');
    const tokens = await requestTokens(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }));
    const updatedAt = new Date().toISOString();
    await db.update('social_accounts', (row) => row.id === account.id, {
      encrypted_access_token: encryptToken(tokens.access_token),
      encrypted_refresh_token: encryptToken(tokens.refresh_token ?? refreshToken),
      expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      scopes: tokens.scope?.split(/\s+/).filter(Boolean) ?? account.scopes,
      status: 'connected',
      updated_at: updatedAt,
    });
    const updated = { ...account, status: 'connected' as const };
    return { account: updated, accessToken: tokens.access_token };
  } catch (error) {
    await markNeedsReconnect(account);
    if (error instanceof AppError) {
      throw new AppError(409, 'x_account_needs_reconnect', `X token refresh failed. Reconnect your account. ${error.message}`);
    }
    throw new AppError(409, 'x_account_needs_reconnect', 'X token refresh failed. Reconnect your account.');
  }
}

export async function revokeToken(token: string, tokenType: 'access_token' | 'refresh_token'): Promise<void> {
  const { clientId, clientSecret } = configured();
  const response = await fetchX(X_REVOKE_URL, {
    method: 'POST',
    headers: {
      Authorization: clientAuthHeader(clientId, clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      token,
      token_type_hint: tokenType,
    }),
  }, 'revoke the access token');
  if (!response.ok && response.status !== 400 && response.status !== 401) {
    const payload = await readResponse(response);
    throw new AppError(response.status, 'x_revoke_failed', xErrorMessage(response.status, payload, 'revoke the access token'));
  }
}

export async function disconnectAccount(userId: string): Promise<void> {
  const account = await db.get('social_accounts', (row) => row.user_id === userId && row.platform === 'x') as SocialAccount | undefined;
  if (!account) return;
  await revokeToken(decryptToken(account.encrypted_access_token), 'access_token');
  await revokeToken(decryptToken(account.encrypted_refresh_token), 'refresh_token');
  await db.remove('social_accounts', (row) => row.id === account.id);
}

export async function postTestTweet(userId: string, text: string) {
  const { account, accessToken } = await getValidAccessToken(userId);
  const response = await fetchX(`${X_API_URL}/tweets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  }, 'post the test tweet');
  const payload = await readResponse(response);
  if (!response.ok) {
    if (response.status === 401) await markNeedsReconnect(account);
    throw new AppError(response.status, 'x_test_tweet_failed', xErrorMessage(response.status, payload, 'post the test tweet'));
  }
  return payload;
}

export async function createOAuthStateRow(userId: string, state: string, verifier: string, expiresAt: string) {
  await db.remove('x_oauth_states', (row) => Date.parse(row.expires_at) <= Date.now());
  return db.insert('x_oauth_states', {
    user_id: userId,
    state,
    code_verifier: verifier,
    expires_at: expiresAt,
  });
}

export async function consumeOAuthState(state: string) {
  const row = await db.get('x_oauth_states', (item) => item.state === state);
  if (!row) return null;
  await db.remove('x_oauth_states', (item) => item.id === row.id);
  if (Date.parse(row.expires_at) <= Date.now()) return null;
  return row as { user_id: string; code_verifier: string };
}
