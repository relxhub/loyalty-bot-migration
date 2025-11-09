-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SuperAdmin', 'Admin');

-- CreateTable
CREATE TABLE "Customer" (
    "customerId" TEXT NOT NULL,
    "referrerId" TEXT,
    "points" INTEGER NOT NULL DEFAULT 0,
    "expiryDate" TIMESTAMP(3) NOT NULL,
    "telegramUserId" TEXT,
    "verificationCode" TEXT,
    "adminCreatedBy" TEXT NOT NULL,
    "referralCount" INTEGER NOT NULL DEFAULT 0,
    "activeCampaignTag" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("customerId")
);

-- CreateTable
CREATE TABLE "Admin" (
    "telegramId" TEXT NOT NULL,
    "name" TEXT,
    "role" "Role" NOT NULL DEFAULT 'Admin',

    CONSTRAINT "Admin_pkey" PRIMARY KEY ("telegramId")
);

-- CreateTable
CREATE TABLE "Reward" (
    "rewardId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "points" INTEGER NOT NULL,

    CONSTRAINT "Reward_pkey" PRIMARY KEY ("rewardId")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" SERIAL NOT NULL,
    "campaignName" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "baseReferral" INTEGER NOT NULL DEFAULT 50,
    "milestoneTarget" INTEGER NOT NULL DEFAULT 0,
    "milestoneBonus" INTEGER NOT NULL DEFAULT 0,
    "linkBonus" INTEGER NOT NULL DEFAULT 50,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemConfig" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "SystemConfig_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AdminLog" (
    "id" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "admin" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "customerId" TEXT,
    "pointsChange" INTEGER NOT NULL DEFAULT 0,
    "details" TEXT,

    CONSTRAINT "AdminLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerLog" (
    "id" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "telegramUserId" TEXT NOT NULL,
    "customerId" TEXT,
    "action" TEXT NOT NULL,
    "pointsChange" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CustomerLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_telegramUserId_key" ON "Customer"("telegramUserId");

-- CreateIndex
CREATE INDEX "Customer_verificationCode_idx" ON "Customer"("verificationCode");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_campaignName_key" ON "Campaign"("campaignName");
