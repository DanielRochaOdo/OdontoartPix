import { NextResponse, type NextRequest } from "next/server";
import { hasSupabaseAuthCookie } from "@/lib/supabase/session";

export async function updateSession(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isLogin = pathname === "/login";
  const isApi = pathname.startsWith("/api");
  const hasAuthCookie = hasSupabaseAuthCookie(request.cookies.getAll());
  const response = NextResponse.next({ request });

  // Authentication is cryptographically verified by the protected layout and
  // API handlers. Middleware only redirects requests with no session cookie.
  if (isLogin || isApi || hasAuthCookie) {
    return response;
  }

  const redirectUrl = request.nextUrl.clone();
  redirectUrl.pathname = "/login";
  redirectUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(redirectUrl);
}
