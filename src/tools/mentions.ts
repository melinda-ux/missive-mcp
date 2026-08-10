/**
 * Mention tools: detect @-mentions of a specific person across recent conversations
 *
 * Missive's API has no webhook and no dedicated "mentions" filter — mentions are
 * only exposed as index/length reference data on individual comment objects
 * (comments are the internal team sidebar discussions, distinct from the emails
 * themselves). To find "was I mentioned recently," this tool polls: it walks
 * recently-active conversations and checks each one's recent comments for a
 * mention of the given person, within a lookback window the caller controls.
 *
 * This is meant to be driven by an external scheduler (e.g. a ClickUp Super
 * Agent trigger running every 15-60 minutes) rather than called ad hoc — there
 * is no push mechanism to build on, so *something* has to poll on a cadence.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import type { ClientResolver } from '../types/tools.js';
import type {
  OrganizationsResponse,
  UsersResponse,
  TeamsResponse,
  ConversationsResponse,
  CommentsResponse,
} from '../types/missive.js';
import type { MissiveClient } from '../client.js';

// Email -> Missive user ID cache. Rarely changes, so a coarse TTL is fine and
// saves a full /users scan on every poll.
const userIdCache = new Map<string, { id: string; expires: number }>();
const USER_ID_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function resolveUserId(
  client: MissiveClient,
  email: string,
  organizationIds: string[]
): Promise<string | null> {
  const key = email.toLowerCase();
  const cached = userIdCache.get(key);
  if (cached && Date.now() < cached.expires) return cached.id;

  for (const organizationId of organizationIds) {
    let offset = 0;
    const limit = 200;

    // A handful of pages is plenty for any reasonably-sized org; bail out
    // rather than looping indefinitely if something unexpected happens.
    for (let page = 0; page < 10; page++) {
      const data = await client.get<UsersResponse>('/users', {
        organization: organizationId,
        limit,
        offset,
      });

      const match = data.users.find((u) => u.email?.toLowerCase() === key);
      if (match) {
        userIdCache.set(key, { id: match.id, expires: Date.now() + USER_ID_CACHE_TTL_MS });
        return match.id;
      }

      if (data.users.length < limit) break;
      offset += limit;
    }
  }

  return null;
}

export function registerMentionTools(server: McpServer, getClient: ClientResolver): void {
  server.registerTool(
    'list_recent_mentions',
    {
      title: 'List Recent Mentions',
      description: `Finds recent @-mentions of a specific person in Missive comments (the internal team sidebar discussions on a conversation — NOT the emails/messages themselves).

Missive's API has no webhook or "mentions" filter, so this tool polls: it scans recently-active conversations and checks their comments for a mention of the given person, within a lookback window you control.

Meant to be called on a repeating schedule (e.g. a Super Agent trigger every 15-60 minutes), with since_minutes set a bit longer than the polling interval so nothing falls through the gap between runs. Seeing the same mention across two consecutive runs is expected and harmless — dedupe on comment_id if you need to avoid re-notifying.

Requires the person's email address (looked up against Missive's user list, cached for an hour). Optionally scope to one organization; otherwise every organization this token can see is scanned.`,
      inputSchema: {
        user_email: z
          .string()
          .email()
          .describe('Email address of the person to check mentions for'),
        organization: z
          .string()
          .uuid()
          .optional()
          .describe(
            'Limit the scan to one organization ID (default: all organizations visible to this token)'
          ),
        since_minutes: z
          .number()
          .min(5)
          .max(1440)
          .default(120)
          .describe('How far back to look, in minutes (default 2 hours)'),
        max_conversations: z
          .number()
          .min(1)
          .max(100)
          .default(40)
          .describe('Maximum number of recently-active conversations to scan (caps latency/API calls)'),
      },
    },
    async ({ user_email, organization, since_minutes, max_conversations }, extra) => {
      const client = getClient(extra);
      const sinceCutoff = Math.floor(Date.now() / 1000) - since_minutes * 60;

      let organizationIds: string[];
      if (organization) {
        organizationIds = [organization];
      } else {
        const orgs = await client.get<OrganizationsResponse>('/organizations');
        organizationIds = orgs.organizations.map((o) => o.id);
      }

      const userId = await resolveUserId(client, user_email, organizationIds);
      if (!userId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No user found with email "${user_email}" in the visible organization(s). Double-check the address, or pass an explicit organization ID if they're in one this token can't otherwise see.`,
            },
          ],
          isError: true,
        };
      }

      const mentions: Array<{
        conversation_id: string;
        conversation_subject?: string;
        comment_id: string;
        comment_body?: string;
        author?: { id: string; name?: string; email?: string };
        created_at: number;
      }> = [];

      let conversationsScanned = 0;

      // Missive's /conversations endpoint requires an actual mailbox filter —
      // `organization` alone isn't accepted ("You need to specify at least one
      // mailbox"). `team_all` is the documented way to scope to a shared team
      // inbox, but it takes exactly one team ID at a time, so we enumerate teams
      // per organization and scan each team's "all" mailbox in turn.
      for (const organizationId of organizationIds) {
        if (conversationsScanned >= max_conversations) break;

        const teamsData = await client.get<TeamsResponse>('/teams', {
          organization: organizationId,
          limit: 200,
        });

        for (const team of teamsData.teams) {
          if (conversationsScanned >= max_conversations) break;

          let until: string | undefined;
          let keepPaging = true;

          while (keepPaging && conversationsScanned < max_conversations) {
            const data = await client.get<ConversationsResponse>('/conversations', {
              team_all: team.id,
              limit: 50,
              until,
            });

            if (data.conversations.length === 0) break;

            for (const convo of data.conversations) {
              if (conversationsScanned >= max_conversations) break;
              conversationsScanned++;

              // Conversations come back newest-activity-first, so once we cross
              // the cutoff there's nothing older left worth checking in this team.
              if (convo.last_activity_at < sinceCutoff) {
                keepPaging = false;
                break;
              }

              const commentsData = await client.get<CommentsResponse>(
                `/conversations/${convo.id}/comments`,
                { limit: 20 }
              );

              for (const comment of commentsData.comments) {
                if (comment.created_at < sinceCutoff) continue;
                const wasMentioned = comment.mentions?.some((m) => m.id === userId);
                if (wasMentioned) {
                  mentions.push({
                    conversation_id: convo.id,
                    conversation_subject: convo.subject || convo.latest_message_subject,
                    comment_id: comment.id,
                    comment_body: comment.body,
                    author: comment.author
                      ? {
                          id: comment.author.id,
                          name: comment.author.name,
                          email: comment.author.email,
                        }
                      : undefined,
                    created_at: comment.created_at,
                  });
                }
              }
            }

            if (!keepPaging || data.conversations.length < 50) break;
            const last = data.conversations[data.conversations.length - 1];
            until = String(last.last_activity_at);
          }
        }
      }

      mentions.sort((a, b) => b.created_at - a.created_at);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                user_email,
                since_minutes,
                conversations_scanned: conversationsScanned,
                mentions_found: mentions.length,
                mentions,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
