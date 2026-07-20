import type { NextConfig } from 'next'

const isProd = process.env.TAURI_ENV === 'prod'

const nextConfig: NextConfig = {
  ...(isProd
    ? {
        output: 'export',
        distDir: 'src-tauri/webview-dist',
        trailingSlash: true,
        images: { unoptimized: true },
      }
    : {}),
}

export default nextConfig
