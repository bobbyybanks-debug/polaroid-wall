'use client';

import { useActionState } from 'react';
import { sendSignInLink } from '../actions';

export default function LoginForm({ linkError }: { linkError: boolean }) {
  const [state, action, pending] = useActionState(sendSignInLink, {});
  if (state.sent) {
    return (
      <form>
        <h1>Check your email</h1>
        <p className="muted">If that address can open the archive, a sign-in link is on its way. It works once and expires in an hour.</p>
      </form>
    );
  }
  return (
    <form action={action}>
      <h1>Archive admin</h1>
      <p className="muted" style={{ margin: '0 0 6px' }}>We&apos;ll email you a sign-in link.</p>
      {linkError && <p className="issue">That link has expired or was already used. Ask for a new one.</p>}
      <input name="email" type="email" placeholder="you@example.com" autoComplete="email" required autoFocus />
      <button className="btn dark" type="submit" disabled={pending}>{pending ? 'Sending…' : 'Email me a sign-in link'}</button>
      {state.error && <p className="issue">{state.error}</p>}
    </form>
  );
}
