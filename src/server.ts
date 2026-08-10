#!/usr/bin/env node

/**
 * Missive MCP Server — remote HTTP entry point
 *
 * Hosted server where each user provides their own Missive PAT through
 * the standard MCP OAuth flow. Our server IS the OAuth authorization server.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { MissiveOAuthProvider } from './auth/provider.js';
import { renderAuthorizeForm } from './auth/authorize-page.js';
import { hashPat, storeUser, storeCode } from './auth/storage.js';
import { MissiveClient, getClientForToken } from './client.js';
import type { ClientResolver } from './types/tools.js';
import type { OrganizationsResponse } from './types/missive.js';
import { registerReferenceTools } from './tools/reference.js';
import { registerConversationTools } from './tools/conversations.js';
import { registerMessageTools } from './tools/messages.js';
import { registerDraftTools } from './tools/drafts.js';
import { registerContactTools } from './tools/contacts.js';
import { registerManagementTools } from './tools/management.js';
import { registerMentionTools } from './tools/mentions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Config ---

const PORT = parseInt(process.env.PORT || '3000', 10);
const BASE_URL = process.env.BASE_URL;

if (!BASE_URL) {
  console.error('BASE_URL environment variable is required (e.g., https://missive-mcp.example.com)');
  process.exit(1);
}

if (!process.env.ENCRYPTION_KEY) {
  console.error('ENCRYPTION_KEY environment variable is required (32-byte hex string)');
  process.exit(1);
}

const issuerUrl = new URL(BASE_URL);

// --- OAuth Provider ---

const provider = new MissiveOAuthProvider();

// --- Client Resolver ---

const resolveClient: ClientResolver = (extra) => {
  const token = extra.authInfo?.extra?.missiveToken as string | undefined;
  if (!token) throw new Error('No Missive token in auth context');
  return getClientForToken(token);
};

// --- MCP Server factory ---

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
  registerMentionTools(server, resolveClient);

  return server;
}

// --- Express App ---

const app = express();

// CORS
app.use(cors());

// Auth router — handles /.well-known/*, /authorize, /token, /register
app.use(mcpAuthRouter({ provider, issuerUrl }));

// --- Authorize form page ---

app.get('/authorize-form', (req, res) => {
  const { client_id, redirect_uri, code_challenge, state } = req.query as Record<string, string>;

  if (!client_id || !redirect_uri || !code_challenge) {
    res.status(400).send('Missing required parameters');
    return;
  }

  res.type('html').send(renderAuthorizeForm({
    clientId: client_id,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    state: state || undefined,
  }));
});

// --- Authorize submit handler ---

app.post('/authorize-submit', express.urlencoded({ extended: false }), async (req, res) => {
  const { pat, client_id, redirect_uri, code_challenge, state } = req.body;

  if (!pat || !client_id || !redirect_uri || !code_challenge) {
    res.status(400).type('html').send(renderAuthorizeForm({
      clientId: client_id || '',
      redirectUri: redirect_uri || '',
      codeChallenge: code_challenge || '',
      state,
      error: 'Missing required fields',
    }));
    return;
  }

  // Validate PAT by calling Missive API
  try {
    const client = new MissiveClient(pat);
    await client.get<OrganizationsResponse>('/organizations');
  } catch {
    res.status(400).type('html').send(renderAuthorizeForm({
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      state,
      error: 'Invalid API token. Please check your token and try again.',
    }));
    return;
  }

  // Store user
  const userId = hashPat(pat);
  storeUser(userId, pat);

  // Generate authorization code
  const code = randomBytes(32).toString('base64url');
  storeCode(code, {
    clientId: client_id,
    userId,
    codeChallenge: code_challenge,
    redirectUri: redirect_uri,
  });

  // Redirect back to client with code
  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set('code', code);
  if (state) redirectUrl.searchParams.set('state', state);

  res.redirect(redirectUrl.toString());
});

// --- MCP endpoints (protected by bearer auth) ---

const bearerAuth = requireBearerAuth({ verifier: provider });

// Stateless: one transport per request
app.post('/mcp', bearerAuth, async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  // Attach auth info to the request for the transport
  (req as unknown as { auth?: AuthInfo }).auth = req.auth;

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  await transport.close();
  await server.close();
});

app.get('/mcp', bearerAuth, async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  (req as unknown as { auth?: AuthInfo }).auth = req.auth;

  await server.connect(transport);
  await transport.handleRequest(req, res);
  await transport.close();
  await server.close();
});

app.delete('/mcp', bearerAuth, async (_req, res) => {
  res.status(405).json({ error: 'Session termination not supported in stateless mode' });
});

// --- Start ---

const server = app.listen(PORT, () => {
  console.log(`Missive MCP server listening on port ${PORT}`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`OAuth metadata: ${BASE_URL}/.well-known/oauth-authorization-server`);
});

function shutdown() {
  console.log('Shutting down...');
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
