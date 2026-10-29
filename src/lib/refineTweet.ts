import { z } from 'zod';
import { AppError } from '../errors';
import { db } from '../data';
import { llmJson } from './llm';
import { normalizeStyleCard } from './voiceStyleCard';
import { voiceSlidersPrompt } from './voiceSliders';

export const REFINE_ACTIONS = [
  'more_like_me',
  'funnier',
  'shorter',
  'more_specific',
  'add_story',
] as const;

export type RefineAction = (typeof REFINE_ACTIONS)[number];

const ACTION_HINT: Record<RefineAction, string> = {
  more_like_me: 'Rewrite so it matches the user style card more closely (rhythm, contractions, openings/closings). Keep the same core idea.',
  funnier: 'Make it funnier in the user\'s humor register from the style card. Keep it short and dry if that fits; never slapstick.',
  shorter: 'Cut ruthlessly. Keep the sharpest line and one concrete detail. Under 160 characters if possible.',
  more_specific: 'Add or sharpen one concrete detail (name, number, tool, or moment) from the user profile/material — never invent.',
  add_story: 'Ground it in a real first-person moment from personaCard.stories or experience material. Deadpan, not inspirational.',
};

const Out = z.object({ text: z.string() });

export async function refineTweet(userId: string, tweetId: string, action: RefineAction) {
  const tweet = await db.get('generated_tweets', (t) => t.id === tweetId && t.user_id === userId);
  if (!tweet) throw new AppError(404, 'tweet_not_found', 'No tweet with that id.');
  const profile = await db.get('personality_profiles', (p) => p.user_id === userId);
  if (!profile) throw new AppError(400, 'no_profile', 'No personality profile yet.');

  const style = normalizeStyleCard(profile.style_fingerprint);
  const sliders = voiceSlidersPrompt(profile.voice_sliders);
  const stories = (profile.persona_card?.stories ?? []).slice(0, 8);

  const result = await llmJson(
    {
      kind: 'draft',
      brain: 'You rewrite ONE short social post. Return JSON only: { "text": "..." }. Max 280 chars.',
      system: JSON.stringify({
        styleFingerprint: style,
        voiceGuidance: profile.voice_guidance,
        voiceSliders: sliders,
        stories,
        doList: profile.do_list,
        dontList: profile.dont_list,
      }),
      user: `ACTION: ${action}
INSTRUCTION: ${ACTION_HINT[action]}

ORIGINAL:
"""
${tweet.text}
"""

Rewrite only this draft. Keep the user's voice. Never invent biography. Return { "text": "..." }.`,
      temperature: 0.8,
      meta: { format: action },
    },
    Out,
  );

  const text = result.text.trim().slice(0, 280);
  if (!text) throw new AppError(502, 'empty_refine', 'The model returned an empty rewrite.');

  await db.update('generated_tweets', (t) => t.id === tweetId, {
    text,
    edited_text: text,
    refine_action: action,
    refined_at: new Date().toISOString(),
  });
  await db.insert('feedback_events', {
    user_id: userId,
    tweet_id: tweetId,
    kind: 'refine',
    refine_action: action,
    original_text: tweet.text,
    edited_text: text,
  });

  return (await db.get('generated_tweets', (t) => t.id === tweetId))!;
}
