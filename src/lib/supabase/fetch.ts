const DEFAULT_SUPABASE_AUTH_TIMEOUT_MS = 10_000;
const DEFAULT_SUPABASE_REQUEST_TIMEOUT_MS = 15_000;

function getSupabaseRequestTimeoutMs(input: RequestInfo | URL) {
  const requestUrl = typeof input === "string"
    ? input
    : "url" in input
      ? input.url
      : input.toString();
  const isAuthRequest = requestUrl.includes("/auth/v1/");
  const environmentKey = isAuthRequest
    ? "SUPABASE_AUTH_REQUEST_TIMEOUT_MS"
    : "SUPABASE_REQUEST_TIMEOUT_MS";
  const fallback = isAuthRequest
    ? DEFAULT_SUPABASE_AUTH_TIMEOUT_MS
    : DEFAULT_SUPABASE_REQUEST_TIMEOUT_MS;
  const configured = Number.parseInt(process.env[environmentKey] ?? "", 10);
  if (!Number.isFinite(configured)) return fallback;
  return Math.min(Math.max(configured, 1_000), 15_000);
}

export async function fetchWithSupabaseTimeout(
  input: RequestInfo | URL,
  init?: RequestInit
) {
  const controller = new AbortController();
  const upstreamSignal = init?.signal;
  const abortFromUpstream = () => controller.abort();

  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      controller.abort();
    } else {
      upstreamSignal.addEventListener("abort", abortFromUpstream, { once: true });
    }
  }

  const timeoutId = setTimeout(() => controller.abort(), getSupabaseRequestTimeoutMs(input));

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
}

export function isTransientSupabaseError(error: unknown) {
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : 0;
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();

  return status >= 500 || [
    "abort",
    "timeout",
    "fetch failed",
    "network",
    "socket",
    "econnreset",
    "etimedout",
    "enotfound",
    "eai_again",
    "connection"
  ].some((fragment) => normalized.includes(fragment));
}
