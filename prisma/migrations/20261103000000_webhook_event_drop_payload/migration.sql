-- Webhook bodies carry shopper PII and are no longer written; clear the rows stored before that.
UPDATE "WebhookEvent" SET "payload" = NULL WHERE "payload" IS NOT NULL;
