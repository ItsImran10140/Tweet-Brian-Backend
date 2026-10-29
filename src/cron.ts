import cron from 'node-cron';
import { db } from './data';
import { generateWithEntitlement } from './lib/generateWithEntitlement';
import { decideGenerationAccess } from './lib/gates';
import { learnForAllUsers } from './lib/learnRules';
import { config } from './config';
import { runDigestAll } from './digest/pipeline';
import { notify } from './digest/notify';

function localParts(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}
const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
};

/**
 * Runs for each user whose local time is within the hour after preferred_generation_time and who has no batch today.
 * The shared niche digest is built once a day by its own cron (see startCrons); generateWithEntitlement rebuilds it only if it is missing or stale.
 * Daily auto-batches are paid-only (free users get a single on-demand free batch from the UI).
 */
export async function runGenerationCron(now = new Date(), force = false) {
  const results: Record<string, unknown> = {};
  for (const u of await db.all('users')) {
    if (!u.onboarding_completed) {
      results[u.id] = { skipped: 'onboarding incomplete' };
      continue;
    }
    const access = await decideGenerationAccess(u.id).catch((e) => ({ mode: 'blocked' as const, code: 'error', message: (e as Error).message }));
    if (access.mode !== 'paid') {
      results[u.id] = { skipped: access.mode === 'blocked' ? access.code : 'not_paid' };
      continue;
    }
    const tz = u.timezone || 'Asia/Kolkata';
    const local = localParts(now, tz);
    const pref = toMin(u.preferred_generation_time || '09:00');
    const inWindow = local.minutes >= pref && local.minutes < pref + 60;
    const hasBatchToday = (await db.all('generated_tweets', (t) => t.user_id === u.id && localParts(new Date(t.created_at), tz).date === local.date)).length > 0;
    if (!force && (!inWindow || hasBatchToday)) {
      results[u.id] = { skipped: !inWindow ? 'outside window' : 'batch already today' };
      continue;
    }
    if (!(await db.get('personality_profiles', (p) => p.user_id === u.id))) {
      results[u.id] = { skipped: 'no profile' };
      continue;
    }
    try {
      const r = await generateWithEntitlement(u.id);
      results[u.id] = { batch_id: r.batch_id, saved: r.saved, news_tweets: r.news_tweets, evergreen_tweets: r.evergreen_tweets };
    } catch (e) {
      results[u.id] = { error: (e as Error).message };
    }
  }
  return results;
}

export function startCrons() {
  if (config.digest.enabled && Object.keys(config.digest.niches).length) {
    if (!cron.validate(config.digest.scheduleCron)) console.error(`[cron] digest.schedule_cron "${config.digest.scheduleCron}" is not a valid cron expression: digest cron NOT scheduled.`);
    else {
      cron.schedule(
        config.digest.scheduleCron,
        () => {
          runDigestAll({ trigger: 'cron' })
            .then((r) => console.log('[cron] digest', JSON.stringify(r, (k, v) => (k === 'preview' ? undefined : v))))
            .catch((e) => notify(`Digest cron crashed: ${(e as Error).message}`));
        },
        { timezone: config.digest.timezone },
      );
      console.log(`[cron] daily niche digest scheduled: "${config.digest.scheduleCron}" (${config.digest.timezone})`);
    }
  }
  cron.schedule('5 * * * *', () => {
    runGenerationCron().then((r) => console.log('[cron] generation', r));
  });
  cron.schedule('30 3 * * *', () => {
    learnForAllUsers().then((r) => console.log('[cron] learn', r));
  });
  console.log('[cron] hourly generation + daily learning scheduled');
}
