import { NextResponse, type NextRequest } from 'next/server';
import { supabaseServer } from '@/lib/auth';

/** The emailed sign-in link lands here; swap the code for a session, then open the dashboard. */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  if (code) {
    const sb = await supabaseServer();
    const { error } = await sb.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL('/admin', request.url));
  }
  return NextResponse.redirect(new URL('/admin/login?error=link', request.url));
}
