import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { fetchWithSupabaseTimeout, isTransientSupabaseError } from "@/lib/supabase/fetch";
import { hasSupabaseAuthCookie } from "@/lib/supabase/session";

export async function updateSession(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anon) {
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });
  const pathname = request.nextUrl.pathname;
  const isLogin = pathname === "/login";
  const isApi = pathname.startsWith("/api");
  const hasAuthCookie = hasSupabaseAuthCookie(request.cookies.getAll());

  // Login and API handlers can work without a middleware Auth round trip.
  // Avoid spending the timeout budget validating a missing session.
  if (isApi || !hasAuthCookie) {
    if (!isApi && !isLogin) {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/login";
      redirectUrl.searchParams.set("next", pathname);
      return NextResponse.redirect(redirectUrl);
    }
    return response;
  }

  const supabase = createServerClient(url, anon, {
    global: {
      fetch: fetchWithSupabaseTimeout
    },
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value);
        });

        response = NextResponse.next({ request });

        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      }
    }
  });

  let user = null;
  try {
    const authResult = await supabase.auth.getUser();
    if (authResult.error && isTransientSupabaseError(authResult.error)) {
      console.warn("[AUTH_MIDDLEWARE_PROVIDER_UNAVAILABLE]", {
        message: authResult.error.message,
        status: authResult.error.status ?? null,
        pathname: request.nextUrl.pathname
      });
      return response;
    }
    user = authResult.data.user;
  } catch (error) {
    console.warn("[AUTH_MIDDLEWARE_REQUEST_FAILED]", {
      message: error instanceof Error ? error.message : "Erro desconhecido",
      pathname: request.nextUrl.pathname
    });
    return response;
  }

  if (!user && !isLogin && !isApi) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    redirectUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}
