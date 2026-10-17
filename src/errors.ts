export class ApiError extends Error {
  workerCode?: string;
  workerWindow?: string;
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfter?: number,
    public diagnostics?: Record<string, unknown>,
  ) {
    super(message);
  }
}
export function invalidProviderPayload(message: string) {
  const error = new ApiError(502, "PROVIDER_FAILURE", message);
  error.workerCode = "PROVIDER_INVALID_PAYLOAD";
  return error;
}
export const unavailable = () =>
  new ApiError(
    503,
    "DEPENDENCY_UNAVAILABLE",
    "A required dependency is unavailable.",
  );
