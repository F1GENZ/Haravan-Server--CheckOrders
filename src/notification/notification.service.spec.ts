import type { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { NotificationService } from './notification.service';

jest.mock('axios');

const values: Record<string, string> = {
  TELEGRAM_ALERT_ENABLED: 'true',
  TELEGRAM_BOT_TOKEN: 'bot',
  TELEGRAM_CHAT_ID: 'chat',
  TELEGRAM_ALERT_DEDUPE_SECONDS: '60',
};

describe('NotificationService dedupe window', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    (axios.post as jest.Mock).mockResolvedValue({});
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('suppresses a repeat inside the window, sends again after it, and drops expired keys from memory', async () => {
    const service = new NotificationService({ get: (key: string) => values[key] } as unknown as ConfigService);
    const lastSent = (service as unknown as { lastSent: Map<string, number> }).lastSent;

    await service.notify('EVENT_A', { n: 1 });
    await service.notify('EVENT_A', { n: 1 });
    expect(axios.post).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(61_000);
    await service.notify('EVENT_B', { n: 2 });
    expect(lastSent.size).toBe(1);

    await service.notify('EVENT_A', { n: 1 });
    expect(axios.post).toHaveBeenCalledTimes(3);
  });
});
