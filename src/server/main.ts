import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFateCore } from '../core/createFateCore';
import { startNodeServerWithFactory, type NodeServer } from './compose';
import { startAuthenticatedNodeServerWithFactory, type AuthenticatedNodeServer } from './http/startAuthenticatedNodeServer';

export type { NodeServer, NodeServerReadiness } from './compose';
export type { AuthenticatedNodeServer } from './http/startAuthenticatedNodeServer';

/**
 * Plain Node core entry. It opens no listener. The separate explicit network
 * entry uses the same real Pi core and never accepts a fake adapter selector.
 */
export function startNodeServer(input: unknown): Promise<NodeServer> {
  return startNodeServerWithFactory(input, createFateCore);
}

/** Opt-in loopback service. A failure cannot fall back to a local execution mode. */
export function startAuthenticatedNodeServer(input: unknown): Promise<AuthenticatedNodeServer> {
  return startAuthenticatedNodeServerWithFactory(input, createFateCore);
}

/** Opt-in production web service. dist/web is a sibling of the built dist/server entry, never a workspace or cwd path. */
export function startProductionWebNodeServer(input: unknown): Promise<AuthenticatedNodeServer> {
  const builtWebDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
  return startAuthenticatedNodeServerWithFactory(input, createFateCore, undefined, builtWebDirectory);
}
