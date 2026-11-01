import { Controller, Post, type INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import express from 'express';
import request from 'supertest';
import { TelegramExceptionFilter } from './telegram-exception.filter';
import type { NotificationService } from './notification.service';

@Controller('echo')
class EchoController {
  @Post()
  echo() {
    return { ok: true };
  }
}

describe('TelegramExceptionFilter over a real HTTP request', () => {
  let app: INestApplication;
  const notifyError = jest.fn().mockResolvedValue(undefined);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [EchoController] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.use(express.json({ limit: '1kb' }));
    const config = { get: () => '' } as unknown as ConfigService;
    app.useGlobalFilters(new TelegramExceptionFilter({ notifyError } as unknown as NotificationService, config));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers an over-limit JSON body with 413 and does not page Telegram', async () => {
    const reply = await request(app.getHttpServer())
      .post('/echo')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ pad: 'x'.repeat(4096) }));
    expect(reply.status).toBe(413);
    expect(reply.body).toMatchObject({ statusCode: 413, path: '/echo' });
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('still answers a malformed JSON body with 400 and a normal body with 201', async () => {
    const bad = await request(app.getHttpServer()).post('/echo').set('content-type', 'application/json').send('{"a":');
    expect(bad.status).toBe(400);
    const ok = await request(app.getHttpServer()).post('/echo').set('content-type', 'application/json').send('{"a":1}');
    expect(ok.status).toBe(201);
  });
});
