import type { Notification } from "pg";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { getDbPool } from "@/lib/db/pool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CHANNEL = "odontoartpix_processing";
const HEARTBEAT_INTERVAL_MS = 10_000;
const STREAM_MAX_LIFETIME_MS = 15_000;
const encoder = new TextEncoder();

type ActiveStreamCloser = () => void;

const activeStreamClosers = new Set<ActiveStreamCloser>();
let shutdownHandlersRegistered = false;
let shuttingDown = false;

function encodeEvent(event: string, data: unknown) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function closeActiveStreams() {
  shuttingDown = true;
  for (const closeStream of Array.from(activeStreamClosers)) {
    try {
      closeStream();
    } catch {
      // O shutdown nao deve ser bloqueado por uma conexao individual.
    }
  }
}

function ensureShutdownHandlers() {
  if (shutdownHandlersRegistered) return;
  shutdownHandlersRegistered = true;
  process.once("SIGTERM", closeActiveStreams);
  process.once("SIGINT", closeActiveStreams);
}

export async function GET(request: Request) {
  const auth = await requireApiUser(["administrador", "operador", "visualizador"]);
  if (!auth.ok) return auth.response;

  ensureShutdownHandlers();
  if (shuttingDown) {
    return new Response(null, {
      status: 503,
      headers: { "Cache-Control": "no-store" }
    });
  }

  const pool = getDbPool();
  const client = await pool.connect();
  await client.query(`listen ${CHANNEL}`);

  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let lifetime: ReturnType<typeof setTimeout> | null = null;
  let notificationHandler: ((message: Notification) => void) | null = null;
  let abortHandler: (() => void) | null = null;
  let shutdownCloser: ActiveStreamCloser | null = null;

  const cleanup = async () => {
    if (closed) return;
    closed = true;

    if (shutdownCloser) {
      activeStreamClosers.delete(shutdownCloser);
      shutdownCloser = null;
    }
    if (heartbeat) clearInterval(heartbeat);
    if (lifetime) clearTimeout(lifetime);
    if (notificationHandler) client.off("notification", notificationHandler);
    if (abortHandler) request.signal.removeEventListener("abort", abortHandler);

    try {
      await client.query(`unlisten ${CHANNEL}`);
    } catch {
      // A conexao pode ja ter sido encerrada pelo cliente ou pelo processo.
    }
    client.release();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          void cleanup();
        }
      };

      notificationHandler = (message) => {
        if (message.channel !== CHANNEL) return;
        let payload: unknown = null;
        try {
          payload = message.payload ? JSON.parse(message.payload) : null;
        } catch {
          payload = { raw: message.payload ?? null };
        }
        safeEnqueue(encodeEvent("change", payload));
      };
      client.on("notification", notificationHandler);

      heartbeat = setInterval(() => {
        safeEnqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
      }, HEARTBEAT_INTERVAL_MS);

      const closeStream = () => {
        if (closed) return;
        try {
          controller.close();
        } catch {
          // Stream ja fechado.
        }
        void cleanup();
      };

      shutdownCloser = closeStream;
      activeStreamClosers.add(closeStream);

      abortHandler = closeStream;
      request.signal.addEventListener("abort", abortHandler, { once: true });

      // O EventSource reconecta automaticamente. Limitar a vida do stream garante
      // que o graceful shutdown do Next.js nunca precise esperar uma requisicao SSE
      // indefinida ate o TimeoutStopSec do systemd.
      lifetime = setTimeout(closeStream, STREAM_MAX_LIFETIME_MS);

      if (shuttingDown) {
        closeStream();
        return;
      }

      safeEnqueue(encodeEvent("ready", { connected: true }));
    },
    cancel() {
      return cleanup();
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}
