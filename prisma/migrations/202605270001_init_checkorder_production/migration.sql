-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "orgid" TEXT NOT NULL,
    "orgsub" TEXT,
    "shopDomain" TEXT NOT NULL,
    "customDomain" TEXT,
    "accessTokenCiphertext" TEXT,
    "accessTokenIv" TEXT,
    "accessTokenTag" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "installedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'trial',
    "plan" TEXT NOT NULL DEFAULT 'Trial',
    "subscriptionStatus" TEXT,
    "subscriptionUpdatedAt" TIMESTAMP(3),
    "subscriptionPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppInstall" (
    "id" TEXT NOT NULL,
    "orgid" TEXT NOT NULL,
    "orgsub" TEXT,
    "domain" TEXT,
    "primaryDomain" TEXT,
    "myharavanDomain" TEXT,
    "accessTokenCiphertext" TEXT,
    "accessTokenIv" TEXT,
    "accessTokenTag" TEXT,
    "refreshTokenCiphertext" TEXT,
    "refreshTokenIv" TEXT,
    "refreshTokenTag" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'trial',
    "plan" TEXT,
    "expiresAt" TIMESTAMP(3),
    "installedAt" TIMESTAMP(3),
    "quotaTotal" INTEGER,
    "quotaRemaining" INTEGER,
    "subscriptionStatus" TEXT,
    "subscriptionUpdatedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppInstall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopDomain" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'alias',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopSettings" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orgid" TEXT NOT NULL,
    "settings" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionSnapshot" (
    "id" TEXT NOT NULL,
    "shopId" TEXT,
    "orgid" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LookupEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT,
    "orgid" TEXT NOT NULL,
    "ipHash" TEXT,
    "phoneHash" TEXT,
    "orderCodeHash" TEXT,
    "status" TEXT NOT NULL,
    "resultCount" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "cacheStatus" TEXT,
    "originHost" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LookupEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT,
    "orgid" TEXT,
    "topic" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB,
    "headers" JSONB,
    "status" TEXT NOT NULL DEFAULT 'received',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_orgid_key" ON "Shop"("orgid");

-- CreateIndex
CREATE INDEX "Shop_shopDomain_idx" ON "Shop"("shopDomain");

-- CreateIndex
CREATE INDEX "Shop_status_idx" ON "Shop"("status");

-- CreateIndex
CREATE INDEX "Shop_plan_idx" ON "Shop"("plan");

-- CreateIndex
CREATE UNIQUE INDEX "AppInstall_orgid_key" ON "AppInstall"("orgid");

-- CreateIndex
CREATE INDEX "AppInstall_status_idx" ON "AppInstall"("status");

-- CreateIndex
CREATE INDEX "AppInstall_plan_idx" ON "AppInstall"("plan");

-- CreateIndex
CREATE INDEX "AppInstall_tokenExpiresAt_idx" ON "AppInstall"("tokenExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShopDomain_domain_key" ON "ShopDomain"("domain");

-- CreateIndex
CREATE INDEX "ShopDomain_shopId_idx" ON "ShopDomain"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopSettings_shopId_key" ON "ShopSettings"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopSettings_orgid_key" ON "ShopSettings"("orgid");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionSnapshot_shopId_key" ON "SubscriptionSnapshot"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionSnapshot_orgid_key" ON "SubscriptionSnapshot"("orgid");

-- CreateIndex
CREATE INDEX "SubscriptionSnapshot_status_idx" ON "SubscriptionSnapshot"("status");

-- CreateIndex
CREATE INDEX "SubscriptionSnapshot_plan_idx" ON "SubscriptionSnapshot"("plan");

-- CreateIndex
CREATE INDEX "SubscriptionSnapshot_syncedAt_idx" ON "SubscriptionSnapshot"("syncedAt");

-- CreateIndex
CREATE INDEX "LookupEvent_orgid_createdAt_idx" ON "LookupEvent"("orgid", "createdAt");

-- CreateIndex
CREATE INDEX "LookupEvent_orgid_status_createdAt_idx" ON "LookupEvent"("orgid", "status", "createdAt");

-- CreateIndex
CREATE INDEX "LookupEvent_phoneHash_idx" ON "LookupEvent"("phoneHash");

-- CreateIndex
CREATE INDEX "LookupEvent_orderCodeHash_idx" ON "LookupEvent"("orderCodeHash");

-- CreateIndex
CREATE INDEX "WebhookEvent_orgid_topic_receivedAt_idx" ON "WebhookEvent"("orgid", "topic", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_orgid_status_receivedAt_idx" ON "WebhookEvent"("orgid", "status", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_status_receivedAt_idx" ON "WebhookEvent"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_topic_orgid_payloadHash_key" ON "WebhookEvent"("topic", "orgid", "payloadHash");

-- AddForeignKey
ALTER TABLE "ShopDomain" ADD CONSTRAINT "ShopDomain_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopSettings" ADD CONSTRAINT "ShopSettings_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionSnapshot" ADD CONSTRAINT "SubscriptionSnapshot_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LookupEvent" ADD CONSTRAINT "LookupEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

