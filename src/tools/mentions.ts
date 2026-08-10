/**
 * Mention tools: detect @-mentions of a specific person across recent conversations,
 * and flag which ones they haven't followed up on yet.
 *
 * Missive's API has no webhook and no dedicated "mentions" filter — mentions are
 * only exposed as index/length reference data on individual comment objects
 * (comments are the internal team sidebar discussions, distinct from the emails
 * themselves). To find "was I mentioned recently, and did I ignore it," this tool
 * polls: it walks recently-active conversations, collects comments and messages
 * within a lookback window, and for each mention checks whether the mentioned
 * person posted a comment or sent a message in that conversation afterward.
 *
 * Meant to be run on a schedule that's much lighter than a typical polling
 * job — e.g. once a day, since the point isn't "notify me instantly" but "catch
 * anything I missed." A longer since_minutes on Mondays (to cover the weekend)
 * is just a different argument to the same tool, not a separate code path.
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
  MessagesResponse,
  Comment,
  Message,
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

/**
 * Fetch every comment on a conversation with created_at >= sinceCutoff.
 * /comments is a sub-resource endpoint capped at limit=10 (unlike the
 * top-level /conversations list, which allows up to 50), so this pages
 * through it with the `until` cursor.
 */
async function fetchCommentsSince(
  client: MissiveClient,
  conversationId: string,
  sinceCutoff: number
): Promise<Comment[]> {
  const collected: Comment[] = [];
  let until: string | undefined;

  while (true) {
    const data = await client.get<CommentsResponse>(`/conversations/${conversationId}/comments`, {
      limit: 10,
      until,
    });

    if (data.comments.length === 0) break;

    let hitCutoff = false;
    for (const comment of data.comments) {
      if (comment.created_at < sinceCutoff) {
        hitCutoff = true;
        continue;
      }
      collected.push(comment);
    }

    if (hitCutoff || data.comments.length < 10) break;
    until = String(data.comments[data.comments.length - 1].created_at);
  }

  return collected;
}

/**
 * Fetch every message on a conversation with delivered_at >= sinceCutoff.
 * Same sub-resource limit=10 cap and pagination approach as comments.
 */
async function fetchMessagesSince(
  client: MissiveClient,
  conversationId: string,
  sinceCutoff: number
): Promise<Message[]> {
  const collected: Message[] = [];
  let until: string | undefined;

  while (true) {
    const data = await client.get<MessagesResponse>(`/conversations/${conversationId}/messages`, {
      limit: 10,
      until,
    });

    if (data.messages.length === 0) break;

    let hitCutoff = false;
    for (const message of data.messages) {
      const deliveredAt = message.delivered_at || 0;
      if (deliveredAt < sinceCutoff) {
        hitCutoff = true;
        continue;
      }
      collected.push(message);
    }

    if (hitCutoff || data.messages.length < 10) break;
    const last = data.messages[data.messages.length - 1];
    until = String(last.delivered_at || 0);
  }

  return collected;
}

export function registerMentionTools(server: McpServer, getClient: ClientResolver): void {
  server.registerTool(
    'list_unanswered_mentions',
    {
      title: 'List Unanswered Mentions',
      description: `Finds @-mentions of a specific person in Missive comments (the internal team sidebar discussions on a conversation — NOT the emails themselves) that they have NOT yet followed up on, within a lookback window.

Missive's API has no webhook or "mentions" filter, so this tool polls: it scans recently-active conversations, collects comments and messages within the window, and for each mention checks whether the mentioned person posted a comment or sent a message in that same conversation afterward. If they did, it's considered answered and left out. If not, it's surfaced as needing attention.

Meant for an infrequent check (e.g. once a day, or once after a weekend with a longer since_minutes) rather than a tight polling loop — the point is catching things that got buried, not instant notification. Set since_minutes to cover however far back you want to check (e.g. 1440 for a daily run, ~4320 to also cover a weekend on Mondays).

Requires the person's email address (looked up against Missive's user list, cached for an hour). Optionally scope to one organization; otherwise every organization this token can see is scanned — and every team within it, each with its own scan budget, so one busy team can't crowd out the others.`,
      inputSchema: {
        user_email: z
          .string()
          .email()
          .describe('Email address of the person to check unanswered mentions for'),
        organization: z
          .string()
          .uuid()
          .optional()
          .describe(
            'Limit the scan to one organization ID (default: all organizations visible to this token)'
          ),
        since_minutes: z
          .number()
          .min(30)
          .max(10080)
          .default(1440)
          .describe(
            'How far back to look, in minutes (default 1440 = 24 hours; use something like 4320 on a Monday to also cover the weekend)'
          ),
        max_conversations_per_team: z
          .number()
          .min(1)
          .max(50)
          .default(15)
          .describe(
            'Maximum recently-active conversations to scan PER TEAM (each team gets its own budget, so a busy team can\'t starve others out of being checked at all)'
          ),
      },
    },
    async ({ user_email, organization, since_minutes, max_conversations_per_team }, extra) => {
      const client = getClient(extra);
      const sinceCutoff = Math.floor(Date.now() / 1000) - since_minutes * 60;
      const now = Math.floor(Date.now() / 1000);

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

      const unanswered: Array<{
        conversation_id: string;
        conversation_subject?: string;
        conversation_url?: string;
        comment_id: string;
        comment_body?: string;
        mentioned_by?: { id: string; name?: string; email?: string };
        mentioned_at: number;
        hours_since_mention: number;
      }> = [];

      let conversationsScanned = 0;
      let teamsScanned = 0;

      // Missive's /conversations endpoint requires an actual mailbox filter —
      // `organization` alone isn't accepted ("You need to specify at least one
      // mailbox"). `team_all` is the documented way to scope to a shared team
      // inbox, but it takes exactly one team ID at a time, so we enumerate teams
      // per organization and scan each team's "all" mailbox in turn. Each team
      // gets its own max_conversations_per_team budget so a busy team can't
      // crowd out quieter ones later in the list.
      for (const organizationId of organizationIds) {
        const teamsData = await client.get<TeamsResponse>('/teams', {
          organization: organizationId,
          limit: 200,
        });

        for (const team of teamsData.teams) {
          teamsScanned++;
          let scannedInTeam = 0;

          let until: string | undefined;
          let keepPaging = true;

          while (keepPaging && scannedInTeam < max_conversations_per_team) {
            const data = await client.get<ConversationsResponse>('/conversations', {
              team_all: team.id,
              limit: 50,
              until,
            });

            if (data.conversations.length === 0) break;

            for (const convo of data.conversations) {
              if (scannedInTeam >= max_conversations_per_team) break;
              scannedInTeam++;
              conversationsScanned++;

              // Conversations come back newest-activity-first, so once we cross
              // the cutoff there's nothing older left worth checking in this team.
              if (convo.last_activity_at < sinceCutoff) {
                keepPaging = false;
                break;
              }

              const [commentsInWindow, messagesInWindow] = await Promise.all([
                fetchCommentsSince(client, convo.id, sinceCutoff),
                fetchMessagesSince(client, convo.id, sinceCutoff),
              ]);

              for (const comment of commentsInWindow) {
                const wasMentioned = comment.mentions?.some((m) => m.user_id === userId);
                if (!wasMentioned) continue;

                const repliedWithComment = commentsInWindow.some(
                  (c) => c.author?.id === userId && c.created_at > comment.created_at
                );
                const repliedWithMessage = messagesInWindow.some(
                  (m) =>
                    m.from_field?.address?.toLowerCase() === user_email.toLowerCase() &&
                    (m.delivered_at || 0) > comment.created_at
                );

                if (repliedWithComment || repliedWithMessage) continue;

                unanswered.push({
                  conversation_id: convo.id,
                  conversation_subject: convo.subject || convo.latest_message_subject,
                  conversation_url: convo.web_url,
                  comment_id: comment.id,
                  comment_body: comment.body,
                  mentioned_by: comment.author
                    ? {
                        id: comment.author.id,
                        name: comment.author.name,
                        email: comment.author.email,
                      }
                    : undefined,
                  mentioned_at: comment.created_at,
                  hours_since_mention: Math.round(((now - comment.created_at) / 3600) * 10) / 10,
                });
              }
            }

            if (!keepPaging || data.conversations.length < 50) break;
            const last = data.conversations[data.conversations.length - 1];
            until = String(last.last_activity_at);
          }
        }
      }

      unanswered.sort((a, b) => b.mentioned_at - a.mentioned_at);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                user_email,
                since_minutes,
                max_conversations_per_team,
                teams_scanned: teamsScanned,
                conversations_scanned: conversationsScanned,
                unanswered_mentions_found: unanswered.length,
                unanswered_mentions: unanswered,
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
