import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
    root: __dirname,
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'media.licdn.com',
        pathname: '/**',
      },
    ],
  },
  env: {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  },
  // The web chat widget runs on customers' sites, on every page view: its files must come from the browser's cache.
  // Later rules win for the same header, so the general rule comes first.
  async headers() {
    const cache = (value) => [{ key: 'Cache-Control', value }];
    return [
      // the loader (the address customers paste) and anything asked for without a version: short, refreshed in the background
      { source: '/widget/v1/:file*', headers: cache('public, max-age=300, stale-while-revalidate=86400') },
      // what the loader fetches carries ?v=<content hash> (scripts/outreach-widget-version.mjs): a new file is a new address
      { source: '/widget/v1/:file(chat|video|ask|voice).js', has: [{ type: 'query', key: 'v' }], headers: cache('public, max-age=31536000, immutable') },
      // built-in clips, bot avatars and flags: fixed names, rarely replaced
      { source: '/widget/v1/:dir(presets|avatars|flags)/:file*', headers: cache('public, max-age=604800, stale-while-revalidate=2592000') },
      { source: '/widget/v1/:dir(presets|avatars)/:name(.*\\.json)', headers: cache('public, max-age=300, stale-while-revalidate=86400') },
    ];
  },
};

export default nextConfig;