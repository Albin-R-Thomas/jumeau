-- CreateEnum
CREATE TYPE "AdmissionPhase" AS ENUM ('preparing', 'ready', 'aborting');

-- CreateEnum
CREATE TYPE "BulkStatus" AS ENUM ('queued', 'running', 'pending', 'done', 'failed');

-- CreateEnum
CREATE TYPE "ResultStatus" AS ENUM ('pending', 'in_flight', 'succeeded', 'failed', 'merged');

-- CreateEnum
CREATE TYPE "ResolutionPolicy" AS ENUM ('http_first_match', 'bulk_unambiguous');

-- CreateTable
CREATE TABLE "City" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "state" TEXT,
    "lat" DECIMAL(20,15) NOT NULL,
    "lon" DECIMAL(20,15) NOT NULL,
    "verified_at" TIMESTAMPTZ(3) NOT NULL,
    "verification_version" INTEGER NOT NULL DEFAULT 1,
    "last_refreshed_at" TIMESTAMPTZ(3),
    "last_status" TEXT NOT NULL DEFAULT 'pending',
    "last_error" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "City_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaceIdentityKey" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'openweather',
    "signature_version" INTEGER NOT NULL DEFAULT 1,
    "signature" TEXT NOT NULL,
    "city_id" UUID NOT NULL,

    CONSTRAINT "PlaceIdentityKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CityAlias" (
    "id" UUID NOT NULL,
    "normalization_version" INTEGER NOT NULL DEFAULT 1,
    "normalized_query" TEXT NOT NULL,
    "resolution_policy" "ResolutionPolicy" NOT NULL,
    "display_query" TEXT NOT NULL,
    "city_id" UUID,
    "verified_at" TIMESTAMPTZ(3),
    "revalidate_after" TIMESTAMPTZ(3),
    "verification_status" TEXT NOT NULL DEFAULT 'verified',
    "metadata" JSONB,
    "last_error" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "CityAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuotaSafetyGuard" (
    "scope" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "initialized" BOOLEAN NOT NULL DEFAULT false,
    "last_intent_at" TIMESTAMPTZ(3),
    "hold_until" TIMESTAMPTZ(3),
    "minute_budget" INTEGER NOT NULL,
    "month_budget" INTEGER NOT NULL,
    "blocked_revision" TEXT,
    "blocked_reason" TEXT,

    CONSTRAINT "QuotaSafetyGuard_pkey" PRIMARY KEY ("scope")
);

-- CreateTable
CREATE TABLE "BulkJob" (
    "job_id" UUID NOT NULL,
    "admission_phase" "AdmissionPhase" NOT NULL DEFAULT 'preparing',
    "admission_generation" INTEGER NOT NULL DEFAULT 1,
    "admission_heartbeat" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "BulkStatus" NOT NULL DEFAULT 'queued',
    "input_rows" INTEGER NOT NULL DEFAULT 0,
    "blank_rows" INTEGER NOT NULL DEFAULT 0,
    "rejected_rows" INTEGER NOT NULL DEFAULT 0,
    "admission_duplicate_rows" INTEGER NOT NULL DEFAULT 0,
    "alias_duplicate_rows" INTEGER NOT NULL DEFAULT 0,
    "admitted_entries" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "counters_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "admitted_at" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "last_progress_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "job_error" JSONB,

    CONSTRAINT "BulkJob_pkey" PRIMARY KEY ("job_id")
);

-- CreateTable
CREATE TABLE "BulkEntry" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "first_record_number" INTEGER NOT NULL,
    "first_line" INTEGER NOT NULL,
    "display_city" TEXT NOT NULL,
    "normalized_key" TEXT NOT NULL,
    "normalization_version" INTEGER NOT NULL DEFAULT 1,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "result_id" UUID,

    CONSTRAINT "BulkEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BulkRejectedRow" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "record_number" INTEGER NOT NULL,
    "row_number" INTEGER NOT NULL,
    "end_line" INTEGER NOT NULL,
    "codes" TEXT[],
    "detail" TEXT NOT NULL,
    "value_preview" TEXT NOT NULL,

    CONSTRAINT "BulkRejectedRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BulkResult" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "city_id" UUID,
    "display_city" TEXT NOT NULL,
    "normalized_key" TEXT NOT NULL,
    "status" "ResultStatus" NOT NULL DEFAULT 'pending',
    "merged_into_id" UUID,
    "initial_ordinal" INTEGER NOT NULL,
    "last_error" JSONB,
    "resume_at" TIMESTAMPTZ(3),
    "recovery_condition" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMPTZ(3),
    "weather" JSONB,
    "source" TEXT,
    "fetched_at" TIMESTAMPTZ(3),
    "fresh_until" TIMESTAMPTZ(3),
    "observed_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "provisional_weather" JSONB,
    "provisional_expires_at" TIMESTAMPTZ(3),

    CONSTRAINT "BulkResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BulkDispatch" (
    "id" UUID NOT NULL,
    "job_id" UUID,
    "result_id" UUID,
    "alias_id" UUID,
    "kind" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "due_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivery_status" TEXT NOT NULL DEFAULT 'pending',
    "last_error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "enqueued_at" TIMESTAMPTZ(3),

    CONSTRAINT "BulkDispatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "City_last_refreshed_at_idx" ON "City"("last_refreshed_at");

-- CreateIndex
CREATE UNIQUE INDEX "PlaceIdentityKey_provider_signature_version_signature_key" ON "PlaceIdentityKey"("provider", "signature_version", "signature");

-- CreateIndex
CREATE INDEX "CityAlias_revalidate_after_idx" ON "CityAlias"("revalidate_after");

-- CreateIndex
CREATE INDEX "CityAlias_city_id_idx" ON "CityAlias"("city_id");

-- CreateIndex
CREATE UNIQUE INDEX "CityAlias_normalization_version_normalized_query_resolution_key" ON "CityAlias"("normalization_version", "normalized_query", "resolution_policy");

-- CreateIndex
CREATE INDEX "BulkJob_admission_phase_created_at_idx" ON "BulkJob"("admission_phase", "created_at");

-- CreateIndex
CREATE INDEX "BulkJob_status_expires_at_idx" ON "BulkJob"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "BulkEntry_job_id_ordinal_key" ON "BulkEntry"("job_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "BulkEntry_job_id_normalized_key_normalization_version_key" ON "BulkEntry"("job_id", "normalized_key", "normalization_version");

-- CreateIndex
CREATE UNIQUE INDEX "BulkRejectedRow_job_id_record_number_key" ON "BulkRejectedRow"("job_id", "record_number");

-- CreateIndex
CREATE INDEX "BulkResult_job_id_status_idx" ON "BulkResult"("job_id", "status");

-- CreateIndex
CREATE INDEX "BulkResult_status_resume_at_idx" ON "BulkResult"("status", "resume_at");

-- CreateIndex
CREATE INDEX "BulkResult_status_lease_expires_at_idx" ON "BulkResult"("status", "lease_expires_at");

-- CreateIndex
CREATE INDEX "BulkResult_job_id_completed_at_id_idx" ON "BulkResult"("job_id", "completed_at" DESC, "id");

-- CreateIndex
CREATE INDEX "BulkDispatch_delivery_status_due_at_idx" ON "BulkDispatch"("delivery_status", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "BulkDispatch_result_id_generation_key" ON "BulkDispatch"("result_id", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "BulkDispatch_alias_id_generation_key" ON "BulkDispatch"("alias_id", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "BulkDispatch_job_id_kind_generation_result_id_key" ON "BulkDispatch"("job_id", "kind", "generation", "result_id");

-- AddForeignKey
ALTER TABLE "PlaceIdentityKey" ADD CONSTRAINT "PlaceIdentityKey_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "City"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CityAlias" ADD CONSTRAINT "CityAlias_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "City"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkEntry" ADD CONSTRAINT "BulkEntry_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "BulkJob"("job_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkRejectedRow" ADD CONSTRAINT "BulkRejectedRow_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "BulkJob"("job_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkResult" ADD CONSTRAINT "BulkResult_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "BulkJob"("job_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkDispatch" ADD CONSTRAINT "BulkDispatch_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "BulkJob"("job_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkDispatch" ADD CONSTRAINT "BulkDispatch_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "BulkResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkDispatch" ADD CONSTRAINT "BulkDispatch_alias_id_fkey" FOREIGN KEY ("alias_id") REFERENCES "CityAlias"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Canonical identity is learned after admission. Unresolved strings are independent.
CREATE UNIQUE INDEX "BulkResult_live_city" ON "BulkResult" (job_id,city_id) WHERE city_id IS NOT NULL AND status <> 'merged';
ALTER TABLE "BulkResult" ADD CONSTRAINT "BulkResult_city_fkey" FOREIGN KEY(city_id) REFERENCES "City"(id);
ALTER TABLE "BulkEntry" ADD CONSTRAINT "BulkEntry_result_fkey" FOREIGN KEY(result_id) REFERENCES "BulkResult"(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "BulkJob" ADD CONSTRAINT "BulkJob_counts" CHECK (
 total>=0 AND processed>=0 AND succeeded>=0 AND failed>=0 AND processed=succeeded+failed AND total>=processed AND
 input_rows>=0 AND blank_rows>=0 AND rejected_rows>=0 AND admission_duplicate_rows>=0 AND alias_duplicate_rows>=0 AND admitted_entries>=0 AND
 input_rows=rejected_rows+admission_duplicate_rows+admitted_entries AND total=admitted_entries-alias_duplicate_rows
);
ALTER TABLE "BulkDispatch" ADD CONSTRAINT "BulkDispatch_owner" CHECK (
 (kind='bootstrap' AND job_id IS NOT NULL AND result_id IS NULL AND alias_id IS NULL) OR
 (kind='process-city' AND job_id IS NOT NULL AND result_id IS NOT NULL AND alias_id IS NULL) OR
 (kind='revalidate-alias' AND job_id IS NULL AND result_id IS NULL AND alias_id IS NOT NULL)
);
CREATE UNIQUE INDEX "BulkDispatch_bootstrap" ON "BulkDispatch"(job_id,generation) WHERE kind='bootstrap';
