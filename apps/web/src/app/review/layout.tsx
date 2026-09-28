import Link from "next/link";
import { Logo } from "@/components/Logo";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function ReviewLayout({ children }: { children: React.ReactNode }) {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = user
    ? await supabase.from("profiles").select("role, email").eq("id", user.id).maybeSingle()
    : { data: null };

  return (
    <div className="page">
      <header className="header">
        <Logo />
        <nav className="nav">
          <Link href="/review">Conversations</Link>
          <Link href="/review/evals">Evaluations</Link>
          <form action="/auth/signout" method="post">
            <button className="linklike" type="submit">
              Sign out
            </button>
          </form>
        </nav>
      </header>
      <main className="wide">
        {profile?.role === "admin" ? (
          children
        ) : (
          <p className="error">
            {profile?.email ?? user?.email} does not have reviewer access. Ask an admin to run{" "}
            <code>npm run seed:admin -- {user?.email ?? "you@company.com"}</code>.
          </p>
        )}
      </main>
    </div>
  );
}
