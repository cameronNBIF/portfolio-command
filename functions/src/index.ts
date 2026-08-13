/**
 * Azure Functions entry point.
 *
 * The v4 programming model registers functions as a side effect of importing
 * the module that calls `app.timer(...)`, so this file's job is to import them.
 * The Affinity client is re-exported because the CLI tools and tests consume it
 * directly, without any Functions runtime involved.
 */
import './functions/affinity-sync.js';
import './functions/visible-sync.js';

export * from './affinity/client.js';
export * from './affinity/map.js';
export * from './affinity/sync.js';
export * from './affinity/history.js';
export * from './visible/client.js';
export * from './visible/map.js';
export * from './visible/sync.js';
