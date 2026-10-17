-- PostgreSQL does not automatically index referencing FK columns. This index
-- keeps deletion of large job graphs from rescanning all entry rows per result.
CREATE INDEX "BulkEntry_result_id_idx" ON "BulkEntry"(result_id);
