/** Static export: Vercel serves it as plain files; all data comes from the Cloudflare Worker. */
const nextConfig = { output: 'export', trailingSlash: true, images: { unoptimized: true }, reactStrictMode: true };
export default nextConfig;
