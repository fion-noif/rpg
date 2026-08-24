import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Lets workers open their magic link from a phone/laptop on the LAN instead of
  // just localhost — Next dev otherwise rejects cross-host requests to /_next/*.
  allowedDevOrigins: ['10.0.0.*'],
};

export default nextConfig;
