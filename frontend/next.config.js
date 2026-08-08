/* eslint-disable */
/** @type {import('next').NextConfig} */
const path = require('path');
const { ProvidePlugin } = require('webpack');

const frontendRoot = __dirname;
const workspaceRoot = path.resolve(__dirname, '..');

const nextConfig = {
  // Use standalone output for better package handling
  output: 'standalone',
  // The frontend imports sibling workspace packages (for example
  // `packages/clinical-web`), so tracing must use the monorepo root.
  outputFileTracingRoot: workspaceRoot,

  // Let Next transpile ESM dependencies if needed (Cornerstone 3D is ESM)
  transpilePackages: [
    '@radsysx/clinical-web',
    '@cornerstonejs/core',
    '@cornerstonejs/tools',
    '@cornerstonejs/dicom-image-loader',
    '@icr/polyseg-wasm',
  ],

  // Keep other experimental opts minimal to avoid deprecation warnings
  experimental: {
    // Allow the frontend app to import sibling workspace packages.
    externalDir: true,
  },

  // Turbopack config (Next.js 16 default bundler)
  turbopack: {
    root: workspaceRoot,
    resolveAlias: {
      // Stub out Node.js built-ins that WASM codecs reference but don't need in-browser
      fs: { browser: path.join(frontendRoot, 'empty-module.js') },
      path: 'path-browserify',
      crypto: 'crypto-browserify',
      stream: 'stream-browserify',
      // Client-side polyfills for Cornerstone3D and DICOM dependencies
      buffer: 'buffer',
      'process/browser': 'process/browser',
      util: 'util',
    },
  },

  webpack: (config, { isServer }) => {
    // Resolve fs and other Node.js modules for dependencies
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      path: false,
      crypto: false,
      stream: false,
      util: false,
    };

    // Loading WASM files as assets
    config.module.rules.push({
      test: /\.wasm$/,
      type: 'asset/resource',
    });

    // Handle WebAssembly modules
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
      syncWebAssembly: true,
    };

    // Do not forcibly externalize Cornerstone on server; imports are guarded in code

    // Provide fallbacks for Node.js modules in client
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        buffer: require.resolve('buffer'),
        process: require.resolve('process/browser'),
        path: require.resolve('path-browserify'),
        crypto: require.resolve('crypto-browserify'),
        stream: require.resolve('stream-browserify'),
        util: require.resolve('util'),
      };
      
      // Add plugins for polyfills
      config.plugins = config.plugins || [];
      config.plugins.push(
        new ProvidePlugin({
          Buffer: ['buffer', 'Buffer'],
          process: 'process/browser',
        })
      );
    }

    return config;
  },
  
  // Proxy BiomedParse API requests to the backend during local development
  async rewrites() {
    return [
      {
        source: '/api/biomedparse/:path*',
        destination: `${process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8001'}/api/biomedparse/:path*`,
      },
    ];
  },

  // Additional settings for medical imaging apps
  images: {
    unoptimized: true, // Disable Next.js image optimization for DICOM files
  },

  // The dedicated SWC minifier flag has been removed in Next 15; modern minifier is always on.
}

module.exports = nextConfig 
