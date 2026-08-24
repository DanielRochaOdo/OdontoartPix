import { readdir } from "node:fs/promises";
import path from "node:path";
import { getDbPool } from "../src/lib/db/pool";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "db", "migrations");
const MIGRATION_FILE = /^(\d+)_.*\.sql$/;

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variavel obrigatoria ausente: ${name}`);
  return value;
}

function envBoolean(name: string, defaultValue?: boolean) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw && defaultValue !== undefined) return defaultValue;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} deve ser true ou false.`);
}

async function expectedMigrationVersions() {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && MIGRATION_FILE.test(entry.name))
    .map((entry) => {
      const match = entry.name.match(MIGRATION_FILE);
      if (!match) throw new Error(`Migration invalida: ${entry.name}`);
      return Number(match[1]);
    })
    .sort((a, b) => a - b);
}

function validateEnvironment() {
  requireEnv("DATABASE_HOST");
  requireEnv("DATABASE_PORT");
  requireEnv("DATABASE_NAME");
  requireEnv("DATABASE_USER");
  requireEnv("DATABASE_PASSWORD");
  requireEnv("MENSALIDADES_API_TOKEN");

  const erpBaseUrl = requireEnv("MENSALIDADES_API_BASE_URL");
  const parsedErpUrl = new URL(erpBaseUrl);
  if (parsedErpUrl.protocol !== "http:" && parsedErpUrl.protocol !== "https:") {
    throw new Error("MENSALIDADES_API_BASE_URL deve usar HTTP ou HTTPS.");
  }

  if (!envBoolean("AUTH_COOKIE_SECURE")) {
    throw new Error("AUTH_COOKIE_SECURE deve ser true no preflight de producao.");
  }

  envBoolean("DATABASE_SSL", false);
  envBoolean("PROCESSING_ALLOW_SCHEDULED_SYNC", false);

  const port = Number(process.env.DATABASE_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("DATABASE_PORT invalida.");
  }
}

async function validateDatabase() {
  const expected = await expectedMigrationVersions();
  if (expected.length === 0) {
    throw new Error("Nenhuma migration local foi encontrada.");
  }

  const pool = getDbPool();
  try {
    await pool.query("select 1");

    const applied = await pool.query<{ version: number }>(
      "select version from schema_migrations order by version asc"
    );
    const appliedVersions = applied.rows.map((row) => Number(row.version));

    const missing = expected.filter((version) => !appliedVersions.includes(version));
    if (missing.length > 0) {
      throw new Error(`Migrations pendentes no banco: ${missing.join(", ")}.`);
    }

    const unknown = appliedVersions.filter((version) => !expected.includes(version));
    if (unknown.length > 0) {
      throw new Error(
        `O banco possui migrations que nao existem neste checkout: ${unknown.join(", ")}.`
      );
    }

    const scheduler = await pool.query<{
      scheduler_enabled: boolean;
      system_user_id: string | null;
      user_active: boolean | null;
      login_enabled: boolean | null;
    }>(
      `select s.scheduler_enabled,
              s.system_user_id::text,
              u.active as user_active,
              u.login_enabled
         from processing_scheduler_state s
         left join users u on u.id = s.system_user_id
        where s.settings_key = 'default'
        limit 1`
    );

    const schedulerRow = scheduler.rows[0];
    if (!schedulerRow) {
      throw new Error("processing_scheduler_state/default nao foi configurado.");
    }
    if (!schedulerRow.system_user_id) {
      throw new Error("Identidade tecnica do processamento nao foi configurada.");
    }
    if (schedulerRow.user_active !== true || schedulerRow.login_enabled !== false) {
      throw new Error("Identidade tecnica do processamento esta invalida ou permite login.");
    }

    const requireSchedulerOff = envBoolean(
      "PRODUCTION_PREFLIGHT_REQUIRE_SCHEDULER_OFF",
      true
    );
    const envSchedulerEnabled = envBoolean("PROCESSING_ALLOW_SCHEDULED_SYNC", false);

    if (
      requireSchedulerOff &&
      (schedulerRow.scheduler_enabled || envSchedulerEnabled)
    ) {
      throw new Error(
        "O primeiro corte exige scheduler automatico desligado no ambiente e no banco."
      );
    }

    console.info("[PRODUCTION_PREFLIGHT_OK]", {
      database: "reachable",
      migrations: expected.length,
      schedulerEnabledInDatabase: schedulerRow.scheduler_enabled,
      schedulerEnabledInEnvironment: envSchedulerEnabled,
      schedulerOffRequired: requireSchedulerOff,
      processingIdentity: "valid"
    });
  } finally {
    await pool.end();
  }
}

async function main() {
  validateEnvironment();
  await validateDatabase();
}

main().catch((error) => {
  console.error("[PRODUCTION_PREFLIGHT_FAILED]", {
    message: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
});
