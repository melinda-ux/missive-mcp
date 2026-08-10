#!/usr/bin/env node

/**
 * Missive MCP Server — stdio entry point
 *
 * Reads MISSIVE_API_TOKEN from env for single-user local mode.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getClient } from './client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
import { registerReferenceTools } from './tools/reference.js';
import { registerConversationTools } from './tools/conversations.js';
import { registerMessageTools } from './tools/messages.js';
import { registerDraftTools } from './tools/drafts.js';
import { registerContactTools } from './tools/contacts.js';
import { registerManagementTools } from './tools/management.js';
import { registerMentionTools } from './tools/mentions.js';

async function main() {
  // Validate token on startup (fail fast)
  try {
    getClient();
  } catch (error) {
    console.error(
      'Failed to initialize Missive client:',
      error instanceof Error ? error.message : 'Unknown error'
    );
    process.exit(1);
  }

  const instructions = readFileSync(
    join(__dirname, '..', 'instructions.md'),
    'utf-8'
  );

  const server = new McpServer(
    {
      name: 'missive-mcp',
      version: '1.0.0',
    },
    { instructions }
  );

  // In stdio mode, always return the singleton client
  const resolveClient = () => getClient();

  // Register all tools
  registerReferenceTools(server, resolveClient);
  registerConversationTools(server, resolveClient);
  registerMessageTools(server, resolveClient);
  registerDraftTools(server, resolveClient);
  registerContactTools(server, resolveClient);
  registerManagementTools(server, resolveClient);
  registerMentionTools(server, resolveClient);

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Fatal error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
