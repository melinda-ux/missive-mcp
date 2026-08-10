/**
 * Type definitions for Missive API responses
 */

// Common types
export interface PaginatedResponse<T> {
  has_more: boolean;
  next_cursor?: string;
}

// Organization
export interface Organization {
  id: string;
  name: string;
}

export interface OrganizationsResponse {
  organizations: Organization[];
}

// Team
export interface Team {
  id: string;
  name: string;
  organization: string;
}

export interface TeamsResponse {
  teams: Team[];
}

// User
export interface User {
  id: string;
  email: string;
  name: string;
  organization: string;
}

export interface UsersResponse {
  users: User[];
}

// Contact Book
export interface ContactBook {
  id: string;
  name: string;
}

export interface ContactBooksResponse {
  contact_books: ContactBook[];
}

// Shared Label
export interface SharedLabel {
  id: string;
  name: string;
  color?: string;
  organization: string;
}

export interface SharedLabelsResponse {
  shared_labels: SharedLabel[];
}

// Conversation
export interface Conversation {
  id: string;
  subject?: string;
  latest_message_subject?: string;
  assignees?: User[];
  shared_labels?: SharedLabel[];
  team?: Team;
  organization?: Organization;
  created_at: number;
  last_activity_at: number;
  messages_count: number;
  attachments_count?: number;
  closed?: boolean;
  web_url?: string;
  app_url?: string;
}

export interface ConversationsResponse extends PaginatedResponse<Conversation> {
  conversations: Conversation[];
}

export interface ConversationResponse {
  conversations: Conversation[];
}

// Message
export interface Attachment {
  id: string;
  filename: string;
  size: number;
  content_type: string;
}

export interface EmailAddress {
  address: string;
  name?: string;
}

export interface Message {
  id: string;
  subject?: string;
  preview?: string;
  body?: string;
  from_field?: EmailAddress;
  to_fields?: EmailAddress[];
  cc_fields?: EmailAddress[];
  bcc_fields?: EmailAddress[];
  delivered_at?: number;
  attachments?: Attachment[];
  conversation?: string;
}

export interface MessagesResponse extends PaginatedResponse<Message> {
  messages: Message[];
}

export interface MessageResponse {
  messages: Message[];
}

// Draft
export interface Draft {
  id: string;
  subject?: string;
  body?: string;
  from_field?: EmailAddress;
  to_fields?: EmailAddress[];
  cc_fields?: EmailAddress[];
  bcc_fields?: EmailAddress[];
  conversation?: string;
  send_at?: number;
}

export interface DraftsResponse extends PaginatedResponse<Draft> {
  drafts: Draft[];
}

export interface DraftResponse {
  drafts: Draft[];
}

// Contact
export interface ContactInfo {
  type: 'email' | 'phone_number' | 'twitter' | 'facebook' | 'url' | 'physical_address' | 'custom';
  value: string;
  label?: string;
}

export interface Contact {
  id: string;
  first_name?: string;
  last_name?: string;
  middle_name?: string;
  nickname?: string;
  notes?: string;
  starred?: boolean;
  infos?: ContactInfo[];
}

export interface ContactsResponse extends PaginatedResponse<Contact> {
  contacts: Contact[];
}

export interface ContactResponse {
  contacts: Contact[];
}

// Post
export interface Post {
  id: string;
  text?: string;
  author?: User;
  conversation?: string;
  created_at: number;
  notification?: {
    title?: string;
    body?: string;
  };
  attachments?: Attachment[];
}

export interface PostsResponse {
  posts: Post[];
}

export interface PostResponse {
  posts: Post[];
}

// Comment
// Note: `mentions` is index/length reference data (per Missive's docs), not full
// user objects — just enough to locate the mention in the body text and identify
// who it points at via `id`.
export interface CommentMention {
  id: string;
  index?: number;
  length?: number;
}

export interface Comment {
  id: string;
  body?: string;
  author?: User;
  conversation?: string;
  created_at: number;
  mentions?: CommentMention[];
  attachments?: Attachment[];
  task?: {
    id: string;
    completed?: boolean;
  };
}

export interface CommentsResponse {
  comments: Comment[];
}

// Timeline item - discriminated union for unified conversation view
export type TimelineItem =
  | { type: 'message'; data: Message; timestamp: number }
  | { type: 'post'; data: Post; timestamp: number }
  | { type: 'comment'; data: Comment; timestamp: number };
