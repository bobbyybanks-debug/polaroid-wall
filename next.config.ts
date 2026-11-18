import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Classic caching model: the public wall is cached with unstable_cache and refreshed on Publish.
  cacheComponents: false,
  serverExternalPackages: ['sharp', '@electric-sql/pglite', 'postgres'],
  experimental: {
    // Server actions carry small JSON only; files never pass through the app.
    serverActions: { bodySizeLimit: '1mb' },
  },
};

export default nextConfig;
