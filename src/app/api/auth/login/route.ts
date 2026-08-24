import { NextRequest } from "next/server";
import { z } from "zod";
import { createSession } from "@/lib/auth/session";
import { verifyPassword } from "@/lib/auth/password";
import { dbQuery } from "@/lib/db/pool";
import { fail, ok } from "@/lib/http/api-response";

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1).max(256)
});

type LoginUserRow = {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: "administrador" | "operador" | "visualizador";
  active: boolean;
  login_enabled: boolean;
};

function requestIp(request: NextRequest) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || null;
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_REQUEST", "Requisição inválida.", 400);
  }

  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_CREDENTIALS", "E-mail ou senha inválidos.", 401);
  }

  const email = parsed.data.email.toLowerCase();
  const result = await dbQuery<LoginUserRow>(
    `select id, name, email, password_hash, role, active, login_enabled
       from users
      where lower(email) = $1
      limit 1`,
    [email]
  );

  const user = result.rows[0];
  if (
    !user ||
    !user.active ||
    !user.login_enabled ||
    !(await verifyPassword(parsed.data.password, user.password_hash))
  ) {
    return fail("INVALID_CREDENTIALS", "E-mail ou senha inválidos.", 401);
  }

  await createSession({
    userId: user.id,
    ipAddress: requestIp(request),
    userAgent: request.headers.get("user-agent")
  });

  await dbQuery(
    `update users
        set last_login_at = now(), updated_at = now()
      where id = $1`,
    [user.id]
  );

  await dbQuery(
    `insert into audit_logs (user_id, action, entity_type, entity_id, ip_address, user_agent)
     values ($1, 'login', 'user', $1, nullif($2, '')::inet, $3)`,
    [user.id, requestIp(request), request.headers.get("user-agent")]
  );

  return ok({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role
    }
  });
}
