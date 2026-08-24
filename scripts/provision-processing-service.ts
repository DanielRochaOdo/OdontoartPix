import { randomUUID } from "node:crypto";
import { getDbPool } from "../src/lib/db/pool";
import { hashPassword } from "../src/lib/auth/password";

const SERVICE_NAME = "OdontoartPix Processing Service";
const SERVICE_EMAIL = "odontoartpix-processing@system.local";
const SERVICE_ROLE = "operador";

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

async function main() {
  const expectedDatabase = requiredEnv("EXPECTED_DATABASE");

  if (expectedDatabase !== "odontoart_pix_test" && expectedDatabase !== "odontoart_pix_dev") {
    throw new Error("EXPECTED_DATABASE deve ser odontoart_pix_test ou odontoart_pix_dev.");
  }

  const pool = getDbPool();
  const client = await pool.connect();

  try {
    const identity = await client.query<{ database_name: string; database_user: string }>(
      "select current_database() as database_name, current_user as database_user"
    );

    const databaseName = identity.rows[0]?.database_name;
    if (databaseName !== expectedDatabase) {
      throw new Error(`Proteção de banco: esperado ${expectedDatabase}, conectado em ${databaseName ?? "desconhecido"}.`);
    }

    await client.query("begin");

    const existing = await client.query<{
      id: string;
      name: string;
      email: string;
      role: string;
      active: boolean;
      login_enabled: boolean;
    }>(
      `select id, name, email, role, active, login_enabled
         from users
        where lower(email) = lower($1)
        limit 1
        for update`,
      [SERVICE_EMAIL]
    );

    const current = existing.rows[0] ?? null;

    if (current && current.name !== SERVICE_NAME) {
      throw new Error(
        `PROCESSING_SERVICE_EMAIL_CONFLICT: ${SERVICE_EMAIL} já pertence a outro usuário.`
      );
    }

    let action: "created" | "updated";
    let serviceUser: {
      id: string;
      name: string;
      email: string;
      role: string;
      active: boolean;
      login_enabled: boolean;
    };

    if (!current) {
      const discardedSecret = `${randomUUID()}${randomUUID()}`;
      const passwordHash = await hashPassword(discardedSecret);

      const inserted = await client.query<typeof serviceUser>(
        `insert into users (
           name,
           email,
           password_hash,
           role,
           active,
           login_enabled
         )
         values ($1, $2, $3, $4, true, false)
         returning id, name, email, role, active, login_enabled`,
        [SERVICE_NAME, SERVICE_EMAIL, passwordHash, SERVICE_ROLE]
      );

      serviceUser = inserted.rows[0]!;
      action = "created";
    } else {
      const updated = await client.query<typeof serviceUser>(
        `update users
            set name = $2,
                role = $3,
                active = true,
                login_enabled = false,
                updated_at = now()
          where id = $1::uuid
          returning id, name, email, role, active, login_enabled`,
        [current.id, SERVICE_NAME, SERVICE_ROLE]
      );

      serviceUser = updated.rows[0]!;
      action = "updated";
    }

    const revokedSessions = await client.query(
      `update sessions
          set revoked_at = now()
        where user_id = $1::uuid
          and revoked_at is null`,
      [serviceUser.id]
    );

    if (
      serviceUser.name !== SERVICE_NAME ||
      serviceUser.email.toLowerCase() !== SERVICE_EMAIL ||
      serviceUser.role !== SERVICE_ROLE ||
      serviceUser.active !== true ||
      serviceUser.login_enabled !== false
    ) {
      throw new Error("PROCESSING_SERVICE_IDENTITY_INVALID");
    }

    await client.query("commit");

    console.log(
      JSON.stringify(
        {
          action,
          database: databaseName,
          serviceUser,
          revokedActiveSessions: revokedSessions.rowCount ?? 0
        },
        null,
        2
      )
    );
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
