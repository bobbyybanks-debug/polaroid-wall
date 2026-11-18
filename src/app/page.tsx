import Wall from '@/components/wall/Wall';
import { getPublishedLayout } from '@/lib/public';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const layout = await getPublishedLayout().catch(() => null);
  if (!layout || !layout.prints.length) {
    return (
      <main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', color: 'var(--ink-muted)', fontSize: 13 }}>
        soon
      </main>
    );
  }
  return <Wall layout={layout} />;
}
