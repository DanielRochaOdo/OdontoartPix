import { getSessionUser } from "@/lib/auth/session";

export async function getCurrentUser() {
  return getSessionUser();
}
