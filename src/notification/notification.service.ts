import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

type NotifyContext = Record<string, unknown>;

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private readonly lastSent = new Map<string, number>();

  constructor(private readonly config: ConfigService) {}

  async notify(event: string, context: NotifyContext = {}) {
    const enabled =
      String(
        this.config.get<string>('TELEGRAM_ALERT_ENABLED') || '',
      ).toLowerCase() === 'true';
    const redacted = this.redact(context);

    if (!enabled) {
      this.logger.debug(`${event}: ${JSON.stringify(redacted)}`);
      return;
    }

    const botToken = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    const chatId = this.config.get<string>('TELEGRAM_CHAT_ID');
    if (!botToken || !chatId) return;

    const dedupeSeconds =
      Number(this.config.get<string>('TELEGRAM_ALERT_DEDUPE_SECONDS')) || 300;
    const dedupeKey = `${event}:${JSON.stringify(redacted)}`;
    const last = this.lastSent.get(dedupeKey) || 0;
    if (Date.now() - last < dedupeSeconds * 1000) return;
    this.lastSent.set(dedupeKey, Date.now());

    const appName =
      this.config.get<string>('TELEGRAM_APP_NAME') || 'F1GENZ CheckOrders';
    const appEnv = this.config.get<string>('TELEGRAM_APP_ENV') || 'production';
    const text = this.truncate(
      `[${appName}] ${event}\nEnv: ${appEnv}\n${JSON.stringify(
        redacted,
        null,
        2,
      )}`,
    );

    try {
      await axios.post(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        { chat_id: chatId, text },
        { timeout: 5000 },
      );
    } catch (error) {
      this.logger.warn(
        `Telegram notify failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async notifyError(
    event: string,
    error: unknown,
    context: NotifyContext = {},
  ): Promise<void> {
    await this.notify(event, {
      ...context,
      error_name: error instanceof Error ? error.name : typeof error,
      error_message: error instanceof Error ? error.message : String(error),
      stack:
        process.env.NODE_ENV === 'production'
          ? undefined
          : error instanceof Error
            ? error.stack
            : undefined,
    });
  }

  private redactValue(key: string, value: unknown): unknown {
    const blocked =
      /token|secret|authorization|password|cookie|hmac|client_id|client_secret|api_key|apikey/i;
    if (blocked.test(key)) return '[redacted]';
    if (Array.isArray(value)) {
      return value.map((item) => this.redactUnknown(item));
    }
    if (value && typeof value === 'object') {
      return this.redact(value as Record<string, unknown>);
    }
    return value;
  }

  private redactUnknown(value: unknown): unknown {
    if (Array.isArray(value))
      return value.map((item) => this.redactUnknown(item));
    if (value && typeof value === 'object') {
      return this.redact(value as Record<string, unknown>);
    }
    return value;
  }

  private redact(context: NotifyContext): NotifyContext {
    return Object.entries(context).reduce((acc, [key, value]) => {
      acc[key] = this.redactValue(key, value);
      return acc;
    }, {} as NotifyContext);
  }

  private truncate(text: string): string {
    return text.length > 3900 ? `${text.slice(0, 3890)}\n...[truncated]` : text;
  }
}
