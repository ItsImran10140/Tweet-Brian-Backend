import { config } from '../config';
import { requestJson } from '../lib/http';

export const alertsConfigured = () => Boolean(config.alerts.webhookUrl || (config.alerts.telegramBotToken && config.alerts.telegramChatId));

/** Failure alerts. Optional: a generic webhook (Slack / Discord / anything) and/or Telegram. Never throws. */
export async function notify(message: string): Promise<void> {
  const text = `[Tweet Brain] ${message}`.slice(0, 1800);
  console.warn(text);
  try {
    if (config.alerts.webhookUrl) {
      // "text" works for Slack, "content" for Discord.
      await requestJson(config.alerts.webhookUrl, { method: 'POST', body: { text, content: text }, timeoutMs: 8000 });
    }
    if (config.alerts.telegramBotToken && config.alerts.telegramChatId) {
      await requestJson(`https://api.telegram.org/bot${config.alerts.telegramBotToken}/sendMessage`, { method: 'POST', body: { chat_id: config.alerts.telegramChatId, text }, timeoutMs: 8000 });
    }
  } catch {
    /* an alert must never break the pipeline */
  }
}
