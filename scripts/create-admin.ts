import { Pool } from "pg";
import { hashPassword } from "../src/lib/auth/password";

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

async function main() {
  const email = requiredEnv("ADMIN_EMAIL").toLowerCase();
  const name = requiredEnv("ADMIN_NAME");
  const password = requiredEnv("ADMIN_PASSWORD");

  if (password.length < 12) {
    throw new Error("ADMIN_PASSWORD deve ter pelo menos 12 caracteres.");
  }

  const pool = new Pool({
    host: requiredEnv("DATABASE_HOST"),
    port: Number(process.env.DATABASE_PORT ?? "5432"),
    database: requiredEnv("DATABASE_NAME"),
    user: requiredEnv("DATABASE_USER"),
    password: requiredEnv("DATABASE_PASSWORD"),
    ssl: process.env.DATABASE_SSL?.toLowerCase() === "true"
      ? { rejectUnauthorized: false }
      : false
  });

  try {
    const passwordHash = await hashPassword(password);
    await pool.query(
      `insert into users (name, email, password_hash, role, active)
       values ($1, $2, $3, 'administrador', true)
       on conflict (lower(email)) do update
         set name = excluded.name,
             password_hash = excluded.password_hash,
             role = 'administrador',
             active = true,
             updated_at = now()`,
      [name, email, passwordHash]
    );

    console.log(`Administrador ${email} criado/atualizado com sucesso.`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
