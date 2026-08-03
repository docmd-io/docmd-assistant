/**
 * Core type definitions for docmd-assistant
 * Headless AI Assistant engine powered by aiplug.
 */

export interface AssistantToolParameterProperty {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
  enum?: string[];
  items?: AssistantToolParameterProperty;
}

export interface AssistantToolParameters {
  type: 'object';
  properties: Record<string, AssistantToolParameterProperty>;
  required?: string[];
}

export interface AssistantTool {
  name: string;
  description: string;
  parameters?: AssistantToolParameters | Record<string, any>;
  handler?: (args: any, context?: any) => Promise<any> | any;
  execute?: (args: any, context?: any) => Promise<any> | any;
}

export interface AssistantOptions {
  /** AI Provider (e.g. 'openai', 'anthropic', 'gemini', 'deepseek', 'groq', 'minimax', 'ollama') */
  provider?: string;
  /** Model name (e.g. 'gpt-4o-mini', 'claude-3-5-haiku-20241022') */
  model?: string;
  /** Direct API Key for provider via aiplug */
  apiKey?: string;
  /** Custom Base URL / Gateway */
  baseURL?: string;
  /** Cloud Relay endpoint URL (optional proxy relay connection) */
  relayUrl?: string;
  /** Endpoint URL alias for relay */
  endpoint?: string;
  /** Project ID / Site ID for Cloud Relay */
  projectId?: string;
  /** System prompt instruction for the assistant */
  systemPrompt?: string;
  /** Initial conversation history */
  history?: ChatMessage[];
  /** Custom tools registered on initialization */
  tools?: AssistantTool[];
  /** Temperature setting (0.0 to 1.0) */
  temperature?: number;
  /** Max tokens setting */
  maxTokens?: number;
  /** Reasoning mode toggle or level (disabled by default) */
  reasoning?: boolean | 'none' | 'low' | 'medium' | 'high';
  /** Custom headers for relay requests */
  headers?: Record<string, string>;
}

export interface SearchResultItem {
  title: string;
  path: string;
  snippet: string;
  score?: number;
}

export interface ChatMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  sender?: 'user' | 'assistant' | 'system';
  name?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, any>;
  }>;
  toolCallId?: string;
  timestamp?: number;
}

export interface ChatResponse {
  message: string;
  role: 'assistant';
  unconfigured?: boolean;
  unconfiguredData?: any;
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, any>;
    result?: any;
  }>;
  history: ChatMessage[];
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export type AssistantEventType =
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'error'
  | 'clear';

export interface AssistantEvent {
  type: AssistantEventType;
  data: any;
}

export type AssistantEventListener = (event: AssistantEvent) => void;