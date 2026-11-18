import { notFound } from 'next/navigation';
import Link from 'next/link';
import { requireAdmin } from '@/lib/auth';
import { printDetail, libraryData } from '@/lib/admin-data';
import Sidebar from '@/components/admin/Sidebar';
import PrintDetail from '@/components/admin/PrintDetail';

export const dynamic = 'force-dynamic';

export default async function PrintPage({ params }: PageProps<'/admin/prints/[id]'>) {
  await requireAdmin();
  const { id } = await params;
  const d = await printDetail(id);
  if (!d) notFound();
  const { stats } = await libraryData();
  return (
    <div className="admin">
      <Sidebar on="library" stats={stats} />
      <main className="main">
        <div className="head">
          <div className="crumbs"><Link href="/admin">Library</Link><span>/</span><b>{d.original.filename}</b>{d.siblings.length > 1 && <span className="muted">· print {d.print.number}</span>}</div>
          <span className="sp" />
          {d.prev && <Link className="link" href={`/admin/prints/${d.prev}`}>← Previous</Link>}
          {d.next && <Link className="link" href={`/admin/prints/${d.next}`}>Next →</Link>}
          <Link className="link" href="/admin">Close</Link>
        </div>
        <PrintDetail d={JSON.parse(JSON.stringify(d))} />
      </main>
    </div>
  );
}
