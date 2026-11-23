import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { getDbPool } from "./db/pool";
import { notifyWorkerWakeup, WORKER_WAKEUP_CHANNEL } from "./worker-wakeup-channel";

describe("PostgreSQL worker wakeup delivery", () => {
  it("delivers only notifications from committed transactions", async () => {
    const subscriber = new Client({
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT ?? "5432"),
      database: process.env.DATABASE_NAME,
      user: process.env.DATABASE_USER,
      password: process.env.DATABASE_PASSWORD,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false
    });
    await subscriber.connect();
    const sender = await getDbPool().connect();

    try {
      await subscriber.query(`LISTEN ${WORKER_WAKEUP_CHANNEL}`);
      const payloadPromise = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("LISTEN timeout")), 3000);
        subscriber.once("notification", (message) => {
          clearTimeout(timeout);
          resolve(message.payload ?? "");
        });
      });

      await sender.query("BEGIN");
      await notifyWorkerWakeup(sender, "general-sync", "rolled-back");
      await sender.query("ROLLBACK");

      await sender.query("BEGIN");
      await notifyWorkerWakeup(sender, "general-sync", "committed");
      await sender.query("COMMIT");

      expect(await payloadPromise).toBe("general-sync:committed");
    } finally {
      sender.release();
      await subscriber.end();
    }
  });
});
