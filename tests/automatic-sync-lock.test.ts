import { afterAll, describe, expect, it } from "vitest";
import { getDbPool } from "@/lib/db/pool";
import {
  blockManualSyncWhileAutomaticEnabled,
  isAutomaticSyncEnabled,
  MANUAL_SYNC_LOCK_MESSAGE
} from "@/lib/automatic-sync-lock";

const describeDatabase = process.env.CI === "true" ? describe.sequential : describe.skip;

describeDatabase("automatic sync lock", () => {
  afterAll(async () => {
    await getDbPool().end();
  });

  it("bloqueia disparos manuais quando a automacao esta ativa e libera ao desativar", async () => {
    const pool = getDbPool();
    const initial = await pool.query<{ scheduler_enabled: boolean }>(
      "select scheduler_enabled from processing_scheduler_state where settings_key = 'default'"
    );
    const original = initial.rows[0]?.scheduler_enabled === true;
    try {
      await pool.query(
        "update processing_scheduler_state set scheduler_enabled = true where settings_key = 'default'"
      );
      expect(await isAutomaticSyncEnabled()).toBe(true);
      const blocked = await blockManualSyncWhileAutomaticEnabled();
      expect(blocked?.status).toBe(409);
      const payload = await blocked?.json();
      expect(payload?.error?.message).toBe(MANUAL_SYNC_LOCK_MESSAGE);

      await pool.query(
        "update processing_scheduler_state set scheduler_enabled = false where settings_key = 'default'"
      );
      expect(await isAutomaticSyncEnabled()).toBe(false);
      expect(await blockManualSyncWhileAutomaticEnabled()).toBeNull();
    } finally {
      await pool.query(
        "update processing_scheduler_state set scheduler_enabled = $1 where settings_key = 'default'",
        [original]
      );
    }
  });
});
