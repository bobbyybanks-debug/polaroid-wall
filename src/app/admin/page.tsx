import { requireAdmin } from '@/lib/auth';
import { libraryData } from '@/lib/admin-data';
import Sidebar from '@/components/admin/Sidebar';
import Library from '@/components/admin/Library';

export const dynamic = 'force-dynamic';

export default async function LibraryPage() {
  await requireAdmin();
  const data = await libraryData();
  return (
    <div className="admin">
      <Sidebar on="library" stats={data.stats} />
      <main className="main"><Library data={data} /></main>
    </div>
  );
}
