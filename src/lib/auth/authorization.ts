import type { Role } from "@/lib/auth/types";

export function canManage(role?: Role | string | null) {
  return role === "administrador" || role === "operador";
}

export function canAdmin(role?: Role | string | null) {
  return role === "administrador";
}
