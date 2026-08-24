import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getDbPool } from "../src/lib/db/pool";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "db", "migrations");
const MIGRATION_FILE = /^(\d+)_.*\.sql$/;
const MIGRATION_LOCK_KEY = 2026082401;

type AppliedMigration = {
  version: number;
};

async function listMigrationFiles() {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && MIGRATION_FILE.test(entry.name))
    .map((entry) => {
      const match = entry.name.match(MIGRATION_FILE);
      if (!match) throw new Error(`Migration invalida: ${entry.name}`);
      return { fileName: entry.name, version: Number(match[1]) };
    })
    .sort((a, b) => a.version - b.version || a.fileName.localeCompare(b.fileName));
}

async function main() {
  const pool = getDbPool();
  const client = await pool.connect();

  try {
    await client.query(`
      create table if not exists schema_migrations (
        version integer primary key,
        name text not null,
        applied_at timestamptz not null default now()
      )
    `);

    await client.query("select pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_KEY]);

    const files = await listMigrationFiles();
    for (const migration of files) {
      const applied = await client.query<AppliedMigration>(
        "select version from schema_migrations where version = $1 limit 1",
        [migration.version]
      );

      if (applied.rows[0]) {
        console.info("[DB_MIGRATION_SKIPPED]", migration.fileName);
        continue;
      }

      const sql = await readFile(path.join(MIGRATIONS_DIR, migration.fileName), "utf8");
      console.info("[DB_MIGRATION_START]", migration.fileName);

      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(
          `insert into schema_migrations(version, name)
           values ($1, $2)
           on conflict (version) do nothing`,
          [migration.version, migration.fileName.replace(/\.sql$/, "")]
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw new Error(
          `Falha ao aplicar ${migration.fileName}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }

      console.info("[DB_MIGRATION_APPLIED]", migration.fileName);
    }
  } finally {
    try {
      await client.query("select pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_KEY]);
    } catch {
      // A conexao pode ter sido encerrada por uma falha fatal do PostgreSQL.
    }
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[DB_MIGRATION_FAILED]", {
    message: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
});
