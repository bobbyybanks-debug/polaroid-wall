import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Wall from '@/components/wall/Wall';
import { getPublishedLayout } from '@/lib/public';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: PageProps<'/p/[n]'>): Promise<Metadata> {
  const { n } = await params;
  const layout = await getPublishedLayout().catch(() => null);
  const p = layout?.prints.find((q) => q.n === decodeURIComponent(n));
  if (!p) return {};
  // The JPEG share copy is made at the third size (≈1600 px) or the largest available.
  const jpegSize = p.sizes[Math.min(p.sizes.length - 1, 2)];
  const image = `${p.src}/${jpegSize}.jpg`;
  return {
    title: `${p.n} — Bobby Banks Polaroids`,
    openGraph: { title: `${p.n} — Bobby Banks Polaroids`, images: [{ url: image }] },
    twitter: { card: 'summary_large_image', images: [image] },
  };
}

export default async function PrintPage({ params }: PageProps<'/p/[n]'>) {
  const { n } = await params;
  const layout = await getPublishedLayout().catch(() => null);
  const number = decodeURIComponent(n);
  if (!layout || !layout.prints.some((p) => p.n === number)) notFound();
  return <Wall layout={layout} openNumber={number} />;
}
