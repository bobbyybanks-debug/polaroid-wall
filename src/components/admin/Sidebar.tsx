import Link from 'next/link';
import { signOut } from '@/app/admin/actions';
import { fmtBytes } from '@/lib/limits';

export default function Sidebar({ on, stats }: { on: 'library' | 'wall'; stats?: { prints: number; scans: number; originalBytes: number; lastPublished: string | null } }) {
  const last = stats?.lastPublished ? new Date(stats.lastPublished).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'never';
  return (
    <aside className="side">
      <div className="brand"><b>Bobby Banks</b><span className="muted">Archive admin</span></div>
      <nav>
        <Link href="/admin" className={on === 'library' ? 'on' : ''}>Library</Link>
        <Link href="/admin/wall" className={on === 'wall' ? 'on' : ''}>Wall editor</Link>
        <a href="/" target="_blank" rel="noreferrer">View live site ↗</a>
      </nav>
      <div className="foot mono">
        {stats && <>
          <span>{stats.prints} prints from {stats.scans} scans</span>
          <span>{fmtBytes(stats.originalBytes)} of originals</span>
          <span>Last published {last}</span>
        </>}
        <form action={signOut}><button type="submit">Sign out</button></form>
      </div>
    </aside>
  );
}
