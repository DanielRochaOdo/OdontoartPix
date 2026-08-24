import { getSessionUser } from "@/lib/auth/session";
import type { AuthProfile } from "@/lib/auth/types";

export async function getCurrentProfile(): Promise<AuthProfile | null> {
  const user = await getSessionUser();
  if (!user) return null;

  return {
    id: user.id,
    nome: user.name,
    email: user.email,
    role: user.role,
    ativo: user.active
  };
}
