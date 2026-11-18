import { requireAdmin } from '@/lib/auth';
import { draftLayout, pendingChanges, versions } from '@/lib/placement/service';
import WallEditor from '@/components/admin/WallEditor';

export const dynamic = 'force-dynamic';

export default async function WallEditorPage({ searchParams }: PageProps<'/admin/wall'>) {
  await requireAdmin();
  const sp = await searchParams;
  const [layout, changes, history] = await Promise.all([draftLayout(), pendingChanges(), versions()]);
  return (
    <div className="admin" style={{ display: 'block' }}>
      <WallEditor
        layout={layout}
        changes={changes}
        history={history.filter((v) => v.status !== 'draft').map((v) => ({ id: v.id, status: v.status, publishedAt: v.publishedAt?.toISOString() ?? null, note: v.note }))}
        focus={typeof sp.print === 'string' ? sp.print : null}
      />
    </div>
  );
}
