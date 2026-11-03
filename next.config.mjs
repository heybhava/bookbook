/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.NEXT_DIST_DIR || '.next',
  serverExternalPackages: ['pdfjs-dist', 'mammoth', 'jszip', 'xlsx', 'wordnet-db', 'cmu-pronouncing-dictionary'],
  experimental: { serverActions: { bodySizeLimit: '512mb' } },
  typescript: { ignoreBuildErrors: false },
};
export default nextConfig;
