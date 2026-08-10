#!/usr/bin/env node

/**
 * Missive MCP Server — single-tenant remote HTTP entry point
 *
 * Unlike server.ts (multi-user, server-is-the-OAuth-provider mode), this
 * entry point is for a single hosted deployment that always acts on behalf
 * of ONE Missive account. The Missive API token is supplied once via the
 * MISSIVE_API_TOKEN environment variable — there is no per-user OAuth flow,
 * no PAT form, and no token storage/encryption.
 *
 * This makes it compatible with MCP clients (e.g. ClickUp's "Custom MCP
 * server" connector) that only support connecting with:
 *   - no auth, or
 *   - a static `Authorization` header
 *
 * Auth modes for the `/mcp` endpoint, controlled by env vars:
 *   - MCP_AUTH_TOKEN unset  -> no auth required (anyone with the URL can call it)
 *   - MCP_AUTH_TOKEN set    -> caller must send `Authorization: Bearer <token>`
 *                              (a bare `Authorization: <token>` header, without
 *                              the "Bearer " prefix, is also accepted, since some
 *                              clients don't let you type a scheme prefix)
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { timingSafeEqual } from 'crypto';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getClient } from './client.js';
import { registerReferenceTools } from './tools/reference.js';
import { registerConversationTools } from './tools/conversations.js';
import { registerMessageTools } from './tools/messages.js';
import { registerDraftTools } from './tools/drafts.js';
import { registerContactTools } from './tools/contacts.js';
import { registerManagementTools } from './tools/management.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Config ---

const PORT = parseInt(process.env.PORT || '3000', 10);
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

// Validate the Missive token on startup (fail fast) — also warms the
// singleton client used for every request.
try {
  getClient();
} catch (error) {
  console.error(
    'Failed to initialize Missive client:',
    error instanceof Error ? error.message : 'Unknown error'
  );
  process.exit(1);
}

if (!MCP_AUTH_TOKEN) {
  console.warn(
    'WARNING: MCP_AUTH_TOKEN is not set. The /mcp endpoint will accept unauthenticated ' +
      'requests from anyone who knows the URL. Set MCP_AUTH_TOKEN to require a shared-secret ' +
      'Authorization header instead.'
  );
}

// --- Client Resolver ---
//
// Single-tenant: every request is resolved to the same Missive account,
// regardless of auth info (there isn't any per-user auth info here).

const resolveClient = () => getClient();

// --- MCP Server factory ---
//
// A fresh McpServer + transport is created per request (stateless mode),
// matching the pattern used by the multi-tenant server.ts.

function createMcpServer(): McpServer {
  let instructions: string;
  try {
    instructions = readFileSync(join(__dirname, '..', 'instructions.md'), 'utf-8');
  } catch {
    instructions = '';
  }

  const server = new McpServer(
    { name: 'missive-mcp', version: '1.0.0' },
    { instructions }
  );

  registerReferenceTools(server, resolveClient);
  registerConversationTools(server, resolveClient);
  registerMessageTools(server, resolveClient);
  registerDraftTools(server, resolveClient);
  registerContactTools(server, resolveClient);
  registerManagementTools(server, resolveClient);

  return server;
}

// --- Auth middleware ---

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still run timingSafeEqual against a same-length buffer to avoid
    // leaking length via early return timing.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!MCP_AUTH_TOKEN) {
    next();
    return;
  }

  const header = req.header('authorization') || req.header('Authorization');
  if (!header) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return;
  }

  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : header;

  if (!timingSafeStringEqual(presented, MCP_AUTH_TOKEN)) {
    res.status(401).json({ error: 'Invalid Authorization header' });
    return;
  }

  next();
}

// --- Express App ---

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (_req, res) => {
  res.json({ name: 'missive-mcp', mode: 'single-tenant', status: 'ok' });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// --- MCP endpoints ---
// Stateless: one McpServer + transport per request.

app.post('/mcp', requireAuth, async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', requireAuth, async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res);
});

app.delete('/mcp', requireAuth, async (_req, res) => {
  res.status(405).json({ error: 'Session termination not supported in stateless mode' });
});

// --- Start ---

const server = app.listen(PORT, () => {
  console.log(`Missive MCP server (single-tenant) listening on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`Auth: ${MCP_AUTH_TOKEN ? 'Authorization header required' : 'NONE (open access)'}`);
});

function shutdown() {
  console.log('Shutting down...');
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
