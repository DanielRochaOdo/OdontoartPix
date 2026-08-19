import { LoginForm } from "@/components/login-form";

export default function LoginPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.2),_transparent_42%),linear-gradient(180deg,_#022c22_0%,_#0f172a_100%)] p-6 text-white">
      <div className="w-full max-w-md">
        <LoginForm />
      </div>
    </main>
  );
}
