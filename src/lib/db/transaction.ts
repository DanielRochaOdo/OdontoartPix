import type { PoolClient, QueryResultRow } from "pg";
import { getDbPool } from "@/lib/db/pool";

export async function withTransaction<T>(operation: (client: PoolClient) => Promise<T>) {
  const client = await getDbPool().connect();
  try {
    await client.query("begin");
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function clientQuery<T extends QueryResultRow = QueryResultRow>(
  client: PoolClient,
  text: string,
  values: readonly unknown[] = []
) {
  return client.query<T>(text, [...values]);
}
