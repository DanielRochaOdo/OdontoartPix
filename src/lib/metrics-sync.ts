"use client";

const METRICS_SYNC_CHANNEL = "metrics-sync";
const METRICS_SYNC_KEY = "metrics-sync-ts";

export function emitMetricsSync() {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(METRICS_SYNC_KEY, String(Date.now()));
  } catch {}

  try {
    const channel = new BroadcastChannel(METRICS_SYNC_CHANNEL);
    channel.postMessage({ type: "refresh", ts: Date.now() });
    channel.close();
  } catch {}
}

export function listenMetricsSync(onSync: () => void) {
  if (typeof window === "undefined") {
    return () => {};
  }

  let channel: BroadcastChannel | null = null;

  const handleStorage = (event: StorageEvent) => {
    if (event.key === METRICS_SYNC_KEY) {
      onSync();
    }
  };

  window.addEventListener("storage", handleStorage);

  try {
    channel = new BroadcastChannel(METRICS_SYNC_CHANNEL);
    channel.onmessage = () => onSync();
  } catch {}

  return () => {
    window.removeEventListener("storage", handleStorage);
    channel?.close();
  };
}
