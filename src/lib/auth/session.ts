import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { dbQuery } from "@/lib/db/pool";

export const SESSION_COOKIE_NAME = "odontoartpix_session";
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  role: "administrador" | "operador" | "visualizador";
  active: boolean;
};

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(input: {
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  await dbQuery(
    `insert into sessions (user_id, token_hash, expires_at, ip_address, user_agent)
     values ($1, $2, $3, nullif($4, '')::inet, $5)`,
    [input.userId, tokenHash, expiresAt.toISOString(), input.ipAddress ?? null, input.userAgent ?? null]
  );

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt
  });

  return { expiresAt };
}

export async function revokeCurrentSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (token) {
    await dbQuery(
      `update sessions
          set revoked_at = coalesce(revoked_at, now())
        where token_hash = $1`,
      [hashToken(token)]
    );
  }

  cookieStore.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0
  });
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const result = await dbQuery<SessionUser & { expires_at: Date }>(
    `select
       u.id,
       u.name,
       u.email,
       u.role,
       u.active,
       s.expires_at
     from sessions s
     join users u on u.id = s.user_id
     where s.token_hash = $1
       and s.revoked_at is null
       and s.expires_at > now()
       and u.active = true
     limit 1`,
    [hashToken(token)]
  );

  const row = result.rows[0];
  if (!row) return null;

  await dbQuery(
    `update sessions
        set last_used_at = now()
      where token_hash = $1`,
    [hashToken(token)]
  );

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    active: row.active
  };
}
