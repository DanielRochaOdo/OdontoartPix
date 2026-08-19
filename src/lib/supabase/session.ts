export function hasSupabaseAuthCookie(cookies: Array<{ name: string }>) {
  return cookies.some(({ name }) => name.includes("-auth-token"));
}
