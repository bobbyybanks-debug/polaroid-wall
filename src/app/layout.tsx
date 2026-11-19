import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import './globals.css';

// Self-hosted (from @fontsource) so builds never depend on Google Fonts being reachable.
const inter = localFont({
  src: [
    { path: '../../node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: '../../node_modules/@fontsource/inter/files/inter-latin-500-normal.woff2', weight: '500', style: 'normal' },
  ],
  variable: '--font-inter',
  display: 'swap',
});
const plex = localFont({
  src: [{ path: '../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2', weight: '400', style: 'normal' }],
  variable: '--font-plex-mono',
  display: 'swap',
});

// Poppins matches the menu on Bobby's portfolio (OFL, subset to Latin, see fonts/OFL-Poppins.txt).
const poppins = localFont({
  src: [
    { path: './fonts/poppins-latin-400.woff', weight: '400', style: 'normal' },
    { path: './fonts/poppins-latin-700.woff', weight: '700', style: 'normal' },
  ],
  variable: '--font-poppins',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Bobby Banks — Polaroids',
  description: 'An archive of Polaroids by Bobby Banks.',
  metadataBase: new URL(process.env.SITE_URL ?? 'http://localhost:3000'),
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#F1EDE5',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${inter.variable} ${plex.variable} ${poppins.variable}`}>
      <body>{children}</body>
    </html>
  );
}
