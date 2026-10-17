import { ApiError } from "../errors";
import { WeatherFetcher } from "../weather-fetch";
import { QuotaGuard } from "../quota-guard";
import { BulkRepository, Claim, SafeError } from "./repository";
import { Delivery } from "./queue";

export const permanentCodes = new Set([
  "INVALID_CITY_SYNTAX",
  "CITY_NOT_FOUND",
  "CITY_AMBIGUOUS",
  "CITY_QUALIFICATION_UNVERIFIABLE",
]);
export function backoff(attempts: number, random = Math.random) {
  return Math.min(
    300000,
    5000 * 2 ** Math.min(Math.max(0, attempts - 1), 6) +
      Math.floor(random() * 1001),
  );
}
export class BulkProcessor {
  constructor(
    private repo: BulkRepository,
    public fetcher: WeatherFetcher,
    private guard: QuotaGuard,
    private random = Math.random,
    private now = Date.now,
    private scope: <T>(claim: Claim, fn: () => Promise<T>) => Promise<T> = (
      _r,
      fn,
    ) => fn(),
  ) {}
  async process(data: Delivery) {
    if (!data.result_id) return;
    const claim = await this.repo.claim(data.result_id, data.generation);
    if (!claim) return;
    const timer = setInterval(() => {
      void this.repo.heartbeat(claim).catch(() => {});
    }, this.repo.cfg.BULK_LEASE_HEARTBEAT_SECONDS * 1000);
    try {
      const result = await this.scope(claim, () =>
        this.fetcher.bulk(claim.display_city, (id) =>
          this.repo.bind(claim, id),
        ),
      );
      if (!result) return;
      if (result.kind === "fresh") {
        await this.repo.finish(claim, { snapshot: result.snapshot });
        if (result.snapshot.source === "provider") await this.guard.clearAuth();
      } else await this.defer(claim, result.error, result.provisional);
    } catch (error) {
      if (error instanceof ApiError && permanentCodes.has(error.code))
        await this.repo.finish(claim, { error: this.safe(error) });
      else
        await this.defer(
          claim,
          error instanceof ApiError
            ? error
            : new ApiError(
                503,
                "WORKER_ERROR",
                "Worker operation interrupted; automatic retry scheduled.",
              ),
        );
    } finally {
      clearInterval(timer);
    }
  }
  private safe(e: ApiError): SafeError {
    return {
      code: e.workerCode ?? e.code,
      detail: e.message,
      ...(e.workerWindow ? { window: e.workerWindow } : {}),
      ...(Array.isArray(e.diagnostics?.suggestions)
        ? { suggestions: e.diagnostics.suggestions as string[] }
        : {}),
    };
  }
  private async defer(
    claim: Claim,
    e: ApiError,
    provisional?: import("../weather-fetch").WeatherSnapshot,
  ) {
    if (e.code === "PROVIDER_AUTH_ERROR") await this.guard.blockAuth();
    const condition =
      e.code === "PROVIDER_AUTH_ERROR"
        ? `provider_configuration_repaired:${this.repo.cfg.PROVIDER_CONFIG_REVISION}`
        : e.code === "IDENTITY_REVIEW_REQUIRED"
          ? "identity_mapping_repaired"
          : undefined;
    const resume = condition
      ? undefined
      : new Date(
          this.now() +
            (e.retryAfter
              ? e.retryAfter * 1000
              : Math.min(
                  this.repo.cfg.BULK_PENDING_BACKOFF_MAX_SECONDS * 1000,
                  backoff(claim.attempts, this.random),
                )),
        );
    await this.repo.finish(claim, {
      error: this.safe(e),
      resume_at: resume,
      recovery_condition: condition,
      provisional,
    });
  }
}
