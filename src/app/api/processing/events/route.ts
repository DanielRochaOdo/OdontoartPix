import type { Notification } from "pg";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { getDbPool } from "@/lib/db/pool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CHANNEL = "odontoartpix_processing";
const encoder = new TextEncoder();

function encodeEvent(event: string, data: unknown) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function GET(request: Request) {
  const auth = await requireApiUser(["administrador", "operador", "visualizador"]);
  if (!auth.ok) return auth.response;

  const pool = getDbPool();
  const client = await pool.connect();
  await client.query(`listen ${CHANNEL}`);

  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let notificationHandler: ((message: Notification) => void) | null = null;
  let abortHandler: (() => void) | null = null;

  const cleanup = async () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (notificationHandler) client.off("notification", notificationHandler);
    if (abortHandler) request.signal.removeEventListener("abort", abortHandler);
    try {
      await client.query(`unlisten ${CHANNEL}`);
    } catch {
      // A conexao pode ja ter sido encerrada pelo cliente.
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
      }, 20_000);

      abortHandler = () => {
        try {
          controller.close();
        } catch {
          // Stream ja fechado.
        }
        void cleanup();
      };
      request.signal.addEventListener("abort", abortHandler, { once: true });

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
