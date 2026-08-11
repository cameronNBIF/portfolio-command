import path from 'node:path';

import { config as loadEnv } from 'dotenv';
import type { NextConfig } from 'next';

/**
 * Next reads `.env` from the app directory; this repo keeps ONE `.env` at the
 * workspace root, shared with db:migrate, db:seed, db:types and the importer.
 * Loading it here runs before the server boots, so `DATABASE_URL`,
 * `AUTH_MODE` and the Entra settings reach the API layer.
 *
 * One env file rather than two: a second copy under apps/web is a second thing
 * to keep in step, and the failure mode is a server quietly talking to the
 * wrong database.
 */
loadEnv({ path: path.resolve(import.meta.dirname, '../../.env') });

const WORKSPACE_PACKAGES = [
  '@portfolio-command/metrics',
  '@portfolio-command/contract',
  '@portfolio-command/api',
  '@portfolio-command/db',
];

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
