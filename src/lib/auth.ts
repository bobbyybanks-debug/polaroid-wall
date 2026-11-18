import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createServerClient } from '@supabase/ssr';
import { adminEmails, devAuthBypass, env } from './env';

/** Supabase client bound to the request's cookies (login session only; data goes through Drizzle). */
export async function supabaseServer() {
  const store = await cookies();
  const e = env();
  if (!e.NEXT_PUBLIC_SUPABASE_URL || !e.NEXT_PUBLIC_SUPABASE_ANON_KEY) throw new Error('Supabase is not configured.');
  return createServerClient(e.NEXT_PUBLIC_SUPABASE_URL, e.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try { for (const { name, value, options } of list) store.set(name, value, options); } catch { /* read-only in Server Components */ }
      },
    },
  });
}

export type Admin = { email: string };

/** The signed-in admin, or null. Every dashboard page, action and API route checks this. */
export async function currentAdmin(): Promise<Admin | null> {
  if (devAuthBypass()) return { email: 'dev@localhost' };
  try {
    const sb = await supabaseServer();
    const { data } = await sb.auth.getUser();
    const email = data.user?.email?.toLowerCase();
    if (email && adminEmails().includes(email)) return { email };
  } catch { /* not configured or no session */ }
  return null;
}

export async function requireAdmin(): Promise<Admin> {
  const a = await currentAdmin();
  if (!a) redirect('/admin/login');
  return a;
}

/** For API routes: returns a 401 response when not signed in. */
export async function apiAdmin(): Promise<Admin | Response> {
  const a = await currentAdmin();
  return a ?? Response.json({ error: 'Sign in again.' }, { status: 401 });
}
