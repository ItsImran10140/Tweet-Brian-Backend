export interface VoiceSliders {
  /** 1 = casual, 10 = polished */
  casualPolished: number;
  /** 1 = serious, 10 = funny */
  seriousFunny: number;
  /** 1 = short, 10 = long */
  shortLong: number;
  /** 1 = humble, 10 = bold */
  humbleBold: number;
}

export const DEFAULT_VOICE_SLIDERS: VoiceSliders = {
  casualPolished: 4,
  seriousFunny: 4,
  shortLong: 3,
  humbleBold: 6,
};

function clamp(n: unknown, fallback: number): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(1, Math.min(10, Math.round(v)));
}

export function normalizeVoiceSliders(raw: unknown): VoiceSliders {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    casualPolished: clamp(r.casualPolished ?? r.casual_polished, DEFAULT_VOICE_SLIDERS.casualPolished),
    seriousFunny: clamp(r.seriousFunny ?? r.serious_funny, DEFAULT_VOICE_SLIDERS.seriousFunny),
    shortLong: clamp(r.shortLong ?? r.short_long, DEFAULT_VOICE_SLIDERS.shortLong),
    humbleBold: clamp(r.humbleBold ?? r.humble_bold, DEFAULT_VOICE_SLIDERS.humbleBold),
  };
}

/** Human-readable guidance injected into generation prompts. */
export function voiceSlidersPrompt(raw: unknown): string {
  const s = normalizeVoiceSliders(raw);
  const pole = (v: number, low: string, high: string) => (v <= 4 ? low : v >= 7 ? high : `balanced ${low}/${high}`);
  return [
    `Register: ${pole(s.casualPolished, 'casual', 'polished')} (${s.casualPolished}/10)`,
    `Humor: ${pole(s.seriousFunny, 'serious', 'funny')} (${s.seriousFunny}/10)`,
    `Length: ${pole(s.shortLong, 'short', 'long')} (${s.shortLong}/10)`,
    `Stance: ${pole(s.humbleBold, 'humble', 'bold')} (${s.humbleBold}/10)`,
  ].join('; ');
}
