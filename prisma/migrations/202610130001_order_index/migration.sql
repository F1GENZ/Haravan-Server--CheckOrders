-- CreateTable
CREATE TABLE "OrderIndex" (
    "id" TEXT NOT NULL,
    "orgid" TEXT NOT NULL,
    "haravanOrderId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "phoneKeys" TEXT[],
    "payloadCiphertext" TEXT NOT NULL,
    "payloadIv" TEXT NOT NULL,
    "payloadTag" TEXT NOT NULL,
    "haravanCreatedAt" TIMESTAMP(3),
    "haravanUpdatedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderIndex_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderSyncState" (
    "id" TEXT NOT NULL,
    "orgid" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "nextPage" INTEGER NOT NULL DEFAULT 1,
    "indexedCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderSyncState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderIndex_orgid_orderNumber_idx" ON "OrderIndex"("orgid", "orderNumber");

-- CreateIndex
CREATE INDEX "OrderIndex_orgid_orderName_idx" ON "OrderIndex"("orgid", "orderName");

-- CreateIndex
CREATE INDEX "OrderIndex_phoneKeys_idx" ON "OrderIndex" USING GIN ("phoneKeys");

-- CreateIndex
CREATE INDEX "OrderIndex_orgid_haravanCreatedAt_idx" ON "OrderIndex"("orgid", "haravanCreatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderIndex_orgid_haravanOrderId_key" ON "OrderIndex"("orgid", "haravanOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderSyncState_orgid_key" ON "OrderSyncState"("orgid");
