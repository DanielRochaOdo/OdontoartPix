import { Pool, type PoolConfig, type QueryResultRow } from "pg";

const globalForPg = globalThis as unknown as {
  odontoartPixPool?: Pool;
};

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return value;
}

function createPoolConfig(): PoolConfig {
  const port = Number(process.env.DATABASE_PORT ?? "5432");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("DATABASE_PORT inválida.");
  }

  const sslEnabled = process.env.DATABASE_SSL?.toLowerCase() === "true";

  return {
    host: requiredEnv("DATABASE_HOST"),
    port,
    database: requiredEnv("DATABASE_NAME"),
    user: requiredEnv("DATABASE_USER"),
    password: requiredEnv("DATABASE_PASSWORD"),
    max: Number(process.env.DATABASE_POOL_MAX ?? "10"),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: sslEnabled ? { rejectUnauthorized: false } : false
  };
}

export function getDbPool() {
  if (!globalForPg.odontoartPixPool) {
    globalForPg.odontoartPixPool = new Pool(createPoolConfig());
  }

  return globalForPg.odontoartPixPool;
}

export async function dbQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: readonly unknown[] = []
) {
  return getDbPool().query<T>(text, [...values]);
}
