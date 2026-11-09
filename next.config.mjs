import path from 'node:path';
/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  distDir: process.env.NEXT_DIST_DIR || '.next',
  serverExternalPackages: ['pdfjs-dist', 'mammoth', 'jszip', 'xlsx', 'wordnet-db', 'cmu-pronouncing-dictionary'],
  experimental: { serverActions: { bodySizeLimit: '512mb' }, middlewareClientMaxBodySize: '520mb' }, // Next buffers request bodies for middleware: 10 MB by default, which truncates book uploads
  typescript: { ignoreBuildErrors: false },
  // Desktop bundle: a self-contained server (node_modules traced) that the Electron shell runs. Normal builds are unaffected.
  ...(process.env.FOLIO_STANDALONE === '1' ? { output: 'standalone', outputFileTracingRoot: path.resolve('.') } : {}),
};
export default nextConfig;
