import type { NextConfig } from 'next';

const WORKSPACE_PACKAGES = ['@portfolio-command/metrics', '@portfolio-command/contract'];

const nextConfig: NextConfig = {
  /**
   * The workspace packages ship TypeScript source rather than a build step --
   * one fewer thing to keep in sync, and the whole point of ADR-003's
   * single-language stack. Next has to compile them itself.
   */
  transpilePackages: WORKSPACE_PACKAGES,

  webpack: (config) => {
    /**
     * `packages/metrics` uses NodeNext module resolution, where an import of a
     * sibling `.ts` file is written with a `.js` extension. Webpack resolves
     * that literally and fails. This maps it back.
     *
     * The alternative -- dropping the extensions in the metrics package -- would
     * break its own typecheck and its vitest run, so the bundler bends rather
     * than the library.
     */
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
