CREATE SCHEMA IF NOT EXISTS "public";
CREATE TYPE "HistorySource" AS ENUM ('cache', 'provider');
CREATE TABLE "SearchHistory" (
  "id" UUID NOT NULL,
  "city_name" TEXT NOT NULL,
  "source" "HistorySource" NOT NULL,
  "timestamp" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SearchHistory_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SearchHistory_timestamp_id_idx" ON "SearchHistory"("timestamp" DESC, "id" DESC);
