import { revokeCurrentSession } from "@/lib/auth/session";
import { ok } from "@/lib/http/api-response";

export async function POST() {
  await revokeCurrentSession();
  return ok({ loggedOut: true });
}
