import type { Metadata } from 'next';
import './admin.css';

export const metadata: Metadata = { title: 'Archive admin — Bobby Banks', robots: { index: false, follow: false } };

export default function AdminLayout({ children }: LayoutProps<'/admin'>) {
  return children;
}
