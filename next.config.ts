import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Socket.io path must not be treated as a Next.js API route at the HTTP level
  // The custom server handles /api/socket before Next.js sees it
}

export default nextConfig
