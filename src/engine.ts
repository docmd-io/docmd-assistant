import {
  AssistantOptions,
  AssistantTool,
  ChatMessage,
  ChatResponse,
  AssistantEventType,
  AssistantEvent,
  AssistantEventListener,
  StreamCallbacks,
  StreamStatus
} from './types.js';
import { parseAssistantOutput, cleanAssistantReply } from './utils/sanitizer.js';

export { cleanAssistantReply, parseAssistantOutput };

export const ENGINE_VERSION = typeof process !== 'undefined' && process.env?.ENGINE_VERSION ? process.env.ENGINE_VERSION : '0.1.13';

export const DEFAULT_SYSTEM_PROMPT = `You are docmd assistant — a professional, precise, and concise technical AI assistant for this documentation site.

CRITICAL CONSTRAINTS & BEHAVIORAL RULES:
1. IDENTITY: Your name is "docmd assistant". You are an expert AI guide specifically for this documentation site.
2. STRICT SCOPE & BOUNDARIES: Answer strictly about the software, APIs, tools, installation, configuration, and topics documented on this site. Politely decline off-topic queries.
3. STRICT FACTUALITY & ZERO FABRICATION:
   - Ground all answers, configuration snippets, and code examples STRICTLY in facts, keys, properties, and evidence explicitly retrieved from documentation search results or site tools.
   - NEVER invent, guess, or fabricate non-existent configurations, non-existent API parameters, or unverified settings.
   - If documentation results do not evidence a specific setting, state what is verified and do not invent hypothetical JSON shapes.
4. PROFESSIONAL & CONCISE: Provide direct, succinct, and professional answers. Do NOT use excessive emojis. Avoid conversational filler or boilerplate apologies. Get straight to the point.
5. AUTONOMOUS & PROACTIVE TOOL EXECUTION:
   - Always use your tools proactively. Directly execute the appropriate tool (\`search_documentation\` or \`get_site_structure\`) to retrieve accurate facts before answering.
   - Use \`get_site_structure\` to inspect site topology, available documentation branches, and navigation trees.
   - Use \`search_documentation\` to search release notes, API guides, configuration options, and concepts across all projects.
6. SEARCH STRATEGY — THIS IS CRITICAL:
   - The search index is KEYWORD-BASED ONLY. It matches individual keywords against page titles and content.
   - ALWAYS search with a SINGLE keyword per search call. Never pass full sentences or multi-word phrases.
   - To answer a question, identify 2-3 important keywords and call search_documentation SEPARATELY for each one.
   - Example: For "how to deploy a docmd site locally", make separate calls: search("deploy"), search("local"), search("install").
   - Example: For "what changed in the latest release", call: search("release"), search("changelog").
   - Analyze the combined search results from all calls, then synthesize your answer.
7. VERSION & RELEASE NOTES INTELLIGENCE:
   - Patch releases and changelog updates are documented in the release notes.
   - When asked what the latest release or version is, search with query: "release" or "changelog".
8. HYPERLINKS & CITATIONS: Always include clickable Markdown hyperlinks \`[Page Title](path)\` in your response for referenced documentation pages.
9. CONCISE & CLEAN OUTPUT: Keep your response clean, structured, and concise (under 1500 tokens). Use valid Markdown formatting without raw unescaped HTML or script tags.`;

function truncateContextCleanly(text: string, maxLen: number = 15000): string {
  if (!text || text.length <= maxLen) return text;
  let sliced = text.slice(0, maxLen);
  const lastDoubleNL = sliced.lastIndexOf('\n\n');
  if (lastDoubleNL > maxLen * 0.5) {
    sliced = sliced.slice(0, lastDoubleNL);
  } else {
    const lastNL = sliced.lastIndexOf('\n');
    if (lastNL > maxLen * 0.5) {
      sliced = sliced.slice(0, lastNL);
    }
  }
  const codeFenceCount = (sliced.match(/```/g) || []).length;
  if (codeFenceCount % 2 !== 0) {
    sliced += '\n```';
  }
  return sliced + '\n...[context truncated]';
}

function getToolStatusInfo(toolName: string, args: any): StreamStatus {
  if (toolName === 'search_documentation') {
    const query = args?.query || args?.q || '';
    return {
      text: query ? `Searching documentation for "${query}"...` : 'Searching documentation...',
      icon: 'search'
    };
  }
  if (toolName === 'get_site_structure') {
    return {
      text: 'Inspecting site navigation & structure...',
      icon: 'folder-tree'
    };
  }
  return {
    text: `Running ${toolName}...`,
    icon: 'cog'
  };
}

export class DocmdAssistantEngine {
  private options: AssistantOptions;
  private history: ChatMessage[] = [];
  private tools: Map<string, AssistantTool> = new Map();
  private systemPrompt: string;
  private listeners: Map<AssistantEventType, Set<AssistantEventListener>> = new Map();
  private isExecuting = false;

  constructor(options: AssistantOptions = {}) {
    this.options = { ...options };
    this.systemPrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT;

    if (options.history) {
      this.history = [...options.history];
    }

    if (options.tools) {
      for (const tool of options.tools) {
        this.registerTool(tool);
      }
    }
  }

  // --- Tool Registration Surface ---

  public registerTool(tool: AssistantTool): this {
    if (!tool.name) {
      throw new Error('Tool must have a valid "name" property.');
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  public unregisterTool(name: string): boolean {
    return this.tools.delete(name);
  }

  public getTools(): AssistantTool[] {
    return Array.from(this.tools.values());
  }

  public getTool(name: string): AssistantTool | undefined {
    return this.tools.get(name);
  }

  // --- System Prompt & Configuration Surface ---

  public setSystemPrompt(prompt: string): this {
    this.systemPrompt = prompt;
    return this;
  }

  public appendSystemPrompt(additionalPrompt: string): this {
    this.systemPrompt += `\n\n${additionalPrompt}`;
    return this;
  }

  public getSystemPrompt(): string {
    return this.systemPrompt;
  }

  public updateOptions(newOptions: Partial<AssistantOptions>): this {
    this.options = { ...this.options, ...newOptions };
    if (newOptions.systemPrompt) {
      this.systemPrompt = newOptions.systemPrompt;
    }
    return this;
  }

  // --- State & History Surface ---

  public getHistory(): ChatMessage[] {
    return [...this.history];
  }

  public setHistory(history: ChatMessage[]): this {
    this.history = [...history];
    return this;
  }

  public clearHistory(): this {
    this.history = [];
    this.emit('clear', null);
    return this;
  }

  public addMessage(message: ChatMessage): this {
    this.history.push({
      ...message,
      timestamp: message.timestamp || Date.now()
    });
    return this;
  }

  // --- Event Emitter Surface ---

  public on(event: AssistantEventType, listener: AssistantEventListener): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return this;
  }

  public off(event: AssistantEventType, listener: AssistantEventListener): this {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(listener);
    }
    return this;
  }

  private emit(type: AssistantEventType, data: any): void {
    const set = this.listeners.get(type);
    if (set) {
      const event: AssistantEvent = { type, data };
      for (const listener of set) {
        try {
          listener(event);
        } catch (err) {
          console.error(`[docmd-assistant] Event listener error (${type}):`, err);
        }
      }
    }
  }

  // --- Synchronous Messaging Surface ---

  public async sendMessage(content: string, overrideOptions?: Partial<AssistantOptions>): Promise<ChatResponse> {
    if (this.isExecuting) {
      throw new Error('Assistant is currently processing a response. Please wait for the current query to complete.');
    }

    this.isExecuting = true;
    try {
      const userMsg: ChatMessage = {
        role: 'user',
        content,
        sender: 'user',
        timestamp: Date.now()
      };
      this.addMessage(userMsg);
      this.emit('message', userMsg);

      const opts = { ...this.options, ...overrideOptions };
      const endpoint = opts.relayUrl || opts.endpoint;

      if (opts.apiKey || opts.provider === 'ollama') {
        return await this.runAiplugLoop(opts);
      }

      return await this.runRelayLoop(endpoint || 'https://api.docmd.io/v1/ai/chat', opts);
    } finally {
      this.isExecuting = false;
    }
  }

  // --- Live Streaming Surface ---

  public async sendMessageStream(
    content: string,
    callbacks: StreamCallbacks = {},
    overrideOptions?: Partial<AssistantOptions>
  ): Promise<ChatResponse> {
    if (this.isExecuting) {
      throw new Error('Assistant is currently processing a response. Please wait for the current query to complete.');
    }

    this.isExecuting = true;
    try {
      const userMsg: ChatMessage = {
        role: 'user',
        content,
        sender: 'user',
        timestamp: Date.now()
      };
      this.addMessage(userMsg);
      this.emit('message', userMsg);

      const opts = { ...this.options, ...overrideOptions };
      const endpoint = opts.relayUrl || opts.endpoint;

      callbacks.onStatus?.({ text: 'Thinking...', icon: 'brain' });
      this.emit('status', { text: 'Thinking...', icon: 'brain' });

      let response: ChatResponse;
      if (opts.apiKey || opts.provider === 'ollama') {
        response = await this.runAiplugStreamLoop(opts, callbacks);
      } else {
        response = await this.runRelayStreamLoop(endpoint || 'https://api.docmd.io/v1/ai/chat', opts, callbacks);
      }

      callbacks.onFinish?.(response);
      return response;
    } catch (err: any) {
      callbacks.onError?.(err);
      this.emit('error', err);
      throw err;
    } finally {
      this.isExecuting = false;
    }
  }

  // --- Multi-Turn Autonomous Tool Execution Loop (Direct aiplug Mode) ---

  private async runAiplugLoop(opts: AssistantOptions): Promise<ChatResponse> {
    const { createLLMAdapter } = await import('aiplug');
    const reasoningVal = opts.reasoning ?? false;
    const adapterOptions: Record<string, any> = {
      apiKey: opts.apiKey || '',
      baseURL: opts.baseURL,
      ...(reasoningVal ? { options: { providerOptions: { reasoning: reasoningVal } } } : {})
    };
    if (opts.provider) adapterOptions.provider = opts.provider;
    if (opts.model) adapterOptions.model = opts.model;

    const adapter = createLLMAdapter(adapterOptions as any);

    const toolsDef = this.getTools().map(t => ({
      name: t.name,
      description: t.description,
      parameters: (t.parameters || (t as any).schema || { type: 'object', properties: {} }) as Record<string, unknown>
    }));

    const conversationMessages: Array<{
      role: 'system' | 'user' | 'assistant' | 'tool';
      content?: string;
      toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
      toolResults?: Array<{ toolCallId: string; name: string; content: string; isError?: boolean }>;
    }> = [
      { role: 'system', content: this.systemPrompt }
    ];

    for (const msg of this.history) {
      const role = (msg as any).sender || msg.role;
      conversationMessages.push({
        role: role === 'system' ? 'system' : role === 'assistant' ? 'assistant' : 'user',
        content: msg.content
      });
    }

    const maxTurns = 5;
    let turnCount = 0;
    let finalReplyText = '';

    while (turnCount < maxTurns) {
      turnCount++;
      const res = await adapter.converse(conversationMessages, toolsDef.length > 0 ? toolsDef : undefined);

      const rawContent = res.message?.content || '';
      const parsed = parseAssistantOutput(rawContent);

      // Collect structured tool calls from adapter OR text-parsed tool calls
      const toolCallsToExecute: Array<{ id: string; name: string; args: Record<string, any> }> = [];

      if (res.message?.toolCalls && res.message.toolCalls.length > 0) {
        for (const tc of res.message.toolCalls) {
          toolCallsToExecute.push({
            id: tc.id || `call_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            name: tc.name,
            args: tc.input || {}
          });
        }
      } else if (parsed.extractedToolCalls.length > 0) {
        for (const tc of parsed.extractedToolCalls) {
          toolCallsToExecute.push({
            id: `call_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            name: tc.name,
            args: tc.args || {}
          });
        }
      }

      // If no tool calls, this turn contains the final human-facing response
      if (toolCallsToExecute.length === 0) {
        finalReplyText = parsed.cleanText || rawContent;
        break;
      }

      // Execute tools and append results to conversation turn
      conversationMessages.push({
        role: 'assistant',
        content: parsed.cleanText || '',
        toolCalls: toolCallsToExecute.map(tc => ({ id: tc.id, name: tc.name, input: tc.args }))
      });

      const toolResults: Array<{ toolCallId: string; name: string; content: string; isError?: boolean }> = [];
      for (const tc of toolCallsToExecute) {
        this.emit('tool_call', { name: tc.name, args: tc.args, callId: tc.id });
        try {
          const result = await this.executeTool(tc.name, tc.args);
          this.emit('tool_result', { name: tc.name, args: tc.args, result, callId: tc.id });
          toolResults.push({
            toolCallId: tc.id,
            name: tc.name,
            content: typeof result === 'string' ? result : JSON.stringify(result)
          });
        } catch (err: any) {
          toolResults.push({
            toolCallId: tc.id,
            name: tc.name,
            content: `Error: ${err.message || String(err)}`,
            isError: true
          });
        }
      }

      conversationMessages.push({
        role: 'tool',
        toolResults
      });
    }

    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: finalReplyText || 'No response generated.',
      sender: 'assistant',
      timestamp: Date.now()
    };
    this.addMessage(assistantMsg);
    this.emit('message', assistantMsg);

    return {
      message: assistantMsg.content,
      role: 'assistant',
      history: this.getHistory()
    };
  }

  // --- Multi-Turn Autonomous Tool Execution Loop (Direct aiplug Streaming Mode) ---

  private async runAiplugStreamLoop(opts: AssistantOptions, callbacks: StreamCallbacks): Promise<ChatResponse> {
    const { createLLMAdapter } = await import('aiplug');
    const reasoningVal = opts.reasoning ?? false;
    const adapterOptions: Record<string, any> = {
      apiKey: opts.apiKey || '',
      baseURL: opts.baseURL,
      ...(reasoningVal ? { options: { providerOptions: { reasoning: reasoningVal } } } : {})
    };
    if (opts.provider) adapterOptions.provider = opts.provider;
    if (opts.model) adapterOptions.model = opts.model;

    const adapter = createLLMAdapter(adapterOptions as any);

    const toolsDef = this.getTools().map(t => ({
      name: t.name,
      description: t.description,
      parameters: (t.parameters || (t as any).schema || { type: 'object', properties: {} }) as Record<string, unknown>
    }));

    const conversationMessages: Array<{
      role: 'system' | 'user' | 'assistant' | 'tool';
      content?: string;
      toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
      toolResults?: Array<{ toolCallId: string; name: string; content: string; isError?: boolean }>;
    }> = [
      { role: 'system', content: this.systemPrompt }
    ];

    for (const msg of this.history) {
      const role = (msg as any).sender || msg.role;
      conversationMessages.push({
        role: role === 'system' ? 'system' : role === 'assistant' ? 'assistant' : 'user',
        content: msg.content
      });
    }

    const maxTurns = 5;
    let turnCount = 0;
    let finalAccumulatedText = '';

    while (turnCount < maxTurns) {
      turnCount++;
      let streamBuffer = '';

      const res = await adapter.converseStream!(
        conversationMessages,
        toolsDef.length > 0 ? toolsDef : undefined,
        (delta: string) => {
          streamBuffer += delta;
        }
      );

      const parsed = parseAssistantOutput(streamBuffer);

      // Check for tool calls
      const toolCallsToExecute: Array<{ id: string; name: string; args: Record<string, any> }> = [];

      if (res.message?.toolCalls && res.message.toolCalls.length > 0) {
        for (const tc of res.message.toolCalls) {
          toolCallsToExecute.push({
            id: tc.id || `call_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            name: tc.name,
            args: tc.input || {}
          });
        }
      } else if (parsed.extractedToolCalls.length > 0) {
        for (const tc of parsed.extractedToolCalls) {
          toolCallsToExecute.push({
            id: `call_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            name: tc.name,
            args: tc.args || {}
          });
        }
      }

      if (toolCallsToExecute.length === 0) {
        finalAccumulatedText = parsed.cleanText || streamBuffer;
        // Stream clean final output delta to caller
        callbacks.onChunk?.(finalAccumulatedText);
        this.emit('chunk', finalAccumulatedText);
        break;
      }

      // Execute tool calls and update UI status badges
      conversationMessages.push({
        role: 'assistant',
        content: parsed.cleanText || '',
        toolCalls: toolCallsToExecute.map(tc => ({ id: tc.id, name: tc.name, input: tc.args }))
      });

      const toolResults: Array<{ toolCallId: string; name: string; content: string; isError?: boolean }> = [];
      for (const tc of toolCallsToExecute) {
        const statusInfo = getToolStatusInfo(tc.name, tc.args);
        callbacks.onStatus?.(statusInfo);
        this.emit('status', statusInfo);

        callbacks.onToolCall?.({ name: tc.name, args: tc.args, callId: tc.id });
        this.emit('tool_call', { name: tc.name, args: tc.args, callId: tc.id });

        try {
          const result = await this.executeTool(tc.name, tc.args);
          callbacks.onToolResult?.({ name: tc.name, args: tc.args, result, callId: tc.id });
          this.emit('tool_result', { name: tc.name, args: tc.args, result, callId: tc.id });
          toolResults.push({
            toolCallId: tc.id,
            name: tc.name,
            content: typeof result === 'string' ? result : JSON.stringify(result)
          });
        } catch (err: any) {
          toolResults.push({
            toolCallId: tc.id,
            name: tc.name,
            content: `Error: ${err.message || String(err)}`,
            isError: true
          });
        }
      }

      callbacks.onStatus?.({ text: 'Thinking...', icon: 'brain' });
      this.emit('status', { text: 'Thinking...', icon: 'brain' });

      conversationMessages.push({
        role: 'tool',
        toolResults
      });
    }

    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: finalAccumulatedText || 'No response generated.',
      sender: 'assistant',
      timestamp: Date.now()
    };
    this.addMessage(assistantMsg);
    this.emit('message', assistantMsg);

    return {
      message: assistantMsg.content,
      role: 'assistant',
      history: this.getHistory()
    };
  }

  // --- Multi-Turn Autonomous Tool Execution Loop (Relay Mode) ---

  private async runRelayLoop(endpoint: string, opts: AssistantOptions): Promise<ChatResponse> {
    const reasoningVal = opts.reasoning ?? false;
    const registeredTools = this.getTools().map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters || (t as any).schema
    }));

    const originalUserQuery = this.history[this.history.length - 1]?.content || '';
    let currentHistory = this.history.slice(0, -1).map(m => ({
      sender: m.sender || m.role,
      text: m.content
    }));
    if (currentHistory.length > 12) {
      currentHistory = currentHistory.slice(-12);
    }

    let userMessage = originalUserQuery;
    let allowTools = true;
    const maxTurns = 5;
    let turnCount = 0;
    let finalReply = '';

    while (turnCount < maxTurns) {
      turnCount++;

      const payload: Record<string, any> = {
        projectId: opts.projectId,
        siteId: opts.projectId,
        message: userMessage,
        pageUrl: typeof location !== 'undefined' ? location.href : undefined,
        pageTitle: typeof document !== 'undefined' ? document.title : undefined,
        history: currentHistory,
        systemPrompt: this.systemPrompt,
        reasoning: reasoningVal,
        tools: (allowTools && registeredTools.length > 0) ? registeredTools : undefined
      };
      if (opts.provider) payload.provider = opts.provider;
      if (opts.model) payload.model = opts.model;

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Docmd-Plugin': `docmd-assistant/${ENGINE_VERSION}`,
          ...(opts.headers || {})
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();

      if (data.unconfigured) {
        return {
          message: data.message || 'Configuration incomplete.',
          role: 'assistant',
          unconfigured: true,
          unconfiguredData: data,
          history: this.getHistory()
        };
      }

      if (!res.ok || data.error) {
        throw new Error(data.error || `Relay error (${res.status})`);
      }

      const rawReply = data.text || data.reply || data.response || data.message || '';
      const parsed = parseAssistantOutput(rawReply);

      // Collect tool calls from structured data.tool_calls OR text parsing
      const toolCallsToExecute: Array<{ id: string; name: string; args: any }> = [];
      if (data.tool_calls && Array.isArray(data.tool_calls) && data.tool_calls.length > 0) {
        for (const tc of data.tool_calls) {
          const toolName = tc.name || tc.function?.name;
          const toolArgs = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : (tc.arguments || tc.args || {});
          toolCallsToExecute.push({
            id: tc.id || `call_${Date.now()}`,
            name: toolName,
            args: toolArgs
          });
        }
      } else if (parsed.extractedToolCalls.length > 0) {
        for (const tc of parsed.extractedToolCalls) {
          toolCallsToExecute.push({
            id: `call_${Date.now()}`,
            name: tc.name,
            args: tc.args || {}
          });
        }
      }

      if (toolCallsToExecute.length === 0) {
        finalReply = parsed.cleanText || rawReply || 'No response returned.';
        break;
      }

      // Ensure original user question is present in history before tool logs
      if (currentHistory.length === 0 || currentHistory[currentHistory.length - 1]?.text !== originalUserQuery) {
        currentHistory.push({
          sender: 'user',
          text: originalUserQuery
        });
      }

      // Execute tool calls locally and build synthesis context
      const toolSummaries: string[] = [];
      for (const tc of toolCallsToExecute) {
        this.emit('tool_call', { name: tc.name, args: tc.args, callId: tc.id });
        const result = await this.executeTool(tc.name, tc.args);
        this.emit('tool_result', { name: tc.name, args: tc.args, result, callId: tc.id });

        const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        toolSummaries.push(`[Search Result for ${tc.name}]:\n${resultStr}`);

        currentHistory.push({
          sender: 'assistant',
          text: `[Tool Call: ${tc.name}(${JSON.stringify(tc.args)})]`
        });
        currentHistory.push({
          sender: 'user',
          text: `[Tool Result for ${tc.name}]: ${resultStr.length > 2000 ? resultStr.slice(0, 2000) + '...' : resultStr}`
        });
      }

      const contextStr = truncateContextCleanly(toolSummaries.join('\n\n'), 15000);
      userMessage = `User Question: "${originalUserQuery}"\n\nRetrieved Documentation Context:\n${contextStr}\n\nBased strictly on the documentation search results above, answer the user's question directly with concise explanations, exact commands, and clickable Markdown links. Do not repeat introductory greetings.`;
      allowTools = false;
    }

    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: finalReply,
      sender: 'assistant',
      timestamp: Date.now()
    };
    this.addMessage(assistantMsg);
    this.emit('message', assistantMsg);

    return {
      message: finalReply,
      role: 'assistant',
      history: this.getHistory()
    };
  }

  // --- Multi-Turn Autonomous Tool Execution Loop (Relay Streaming Mode) ---

  private async runRelayStreamLoop(
    endpoint: string,
    opts: AssistantOptions,
    callbacks: StreamCallbacks
  ): Promise<ChatResponse> {
    const reasoningVal = opts.reasoning ?? false;
    const registeredTools = this.getTools().map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters || (t as any).schema
    }));

    const originalUserQuery = this.history[this.history.length - 1]?.content || '';
    let currentHistory = this.history.slice(0, -1).map(m => ({
      sender: m.sender || m.role,
      text: m.content
    }));
    if (currentHistory.length > 12) {
      currentHistory = currentHistory.slice(-12);
    }

    let userMessage = originalUserQuery;
    let allowTools = true;
    const maxTurns = 5;
    let turnCount = 0;
    let finalReply = '';

    while (turnCount < maxTurns) {
      turnCount++;

      const payload: Record<string, any> = {
        projectId: opts.projectId,
        siteId: opts.projectId,
        message: userMessage,
        pageUrl: typeof location !== 'undefined' ? location.href : undefined,
        pageTitle: typeof document !== 'undefined' ? document.title : undefined,
        history: currentHistory,
        systemPrompt: this.systemPrompt,
        reasoning: reasoningVal,
        tools: (allowTools && registeredTools.length > 0) ? registeredTools : undefined,
        stream: true
      };
      if (opts.provider) payload.provider = opts.provider;
      if (opts.model) payload.model = opts.model;

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream, application/json',
          'X-Docmd-Plugin': `docmd-assistant/${ENGINE_VERSION}`,
          ...(opts.headers || {})
        },
        body: JSON.stringify(payload)
      });

      const contentType = res.headers.get('content-type') || '';
      const isEventStream = contentType.toLowerCase().includes('text/event-stream');

      // Standard HTTP response (JSON / text) handling
      if (!isEventStream || !res.body) {
        const textData = await res.text();
        let data: any;
        try {
          data = JSON.parse(textData);
        } catch {
          data = { text: textData };
        }

        if (data.unconfigured) {
          return {
            message: data.message || 'Configuration incomplete.',
            role: 'assistant',
            unconfigured: true,
            unconfiguredData: data,
            history: this.getHistory()
          };
        }
        if (!res.ok || data.error) {
          throw new Error(data.error || `Relay error (${res.status})`);
        }

        const rawReply = data.text || data.reply || data.response || data.message || '';
        const parsed = parseAssistantOutput(rawReply);

        const toolCallsToExecute: Array<{ id: string; name: string; args: any }> = [];
        if (data.tool_calls && Array.isArray(data.tool_calls) && data.tool_calls.length > 0) {
          for (const tc of data.tool_calls) {
            toolCallsToExecute.push({
              id: tc.id || `call_${Date.now()}`,
              name: tc.name || tc.function?.name,
              args: typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : (tc.arguments || tc.args || {})
            });
          }
        } else if (parsed.extractedToolCalls.length > 0) {
          for (const tc of parsed.extractedToolCalls) {
            toolCallsToExecute.push({
              id: `call_${Date.now()}`,
              name: tc.name,
              args: tc.args || {}
            });
          }
        }

        if (toolCallsToExecute.length === 0) {
          finalReply = parsed.cleanText || rawReply || 'No response returned.';
          callbacks.onChunk?.(finalReply);
          this.emit('chunk', finalReply);
          break;
        }

        // Ensure original user question is present in history before tool logs
        if (currentHistory.length === 0 || currentHistory[currentHistory.length - 1]?.text !== originalUserQuery) {
          currentHistory.push({
            sender: 'user',
            text: originalUserQuery
          });
        }

        const toolSummaries: string[] = [];
        for (const tc of toolCallsToExecute) {
          const statusInfo = getToolStatusInfo(tc.name, tc.args);
          callbacks.onStatus?.(statusInfo);
          this.emit('status', statusInfo);

          callbacks.onToolCall?.({ name: tc.name, args: tc.args, callId: tc.id });
          this.emit('tool_call', { name: tc.name, args: tc.args, callId: tc.id });

          const result = await this.executeTool(tc.name, tc.args);
          callbacks.onToolResult?.({ name: tc.name, args: tc.args, result, callId: tc.id });
          this.emit('tool_result', { name: tc.name, args: tc.args, result, callId: tc.id });

          const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          toolSummaries.push(`[Search Result for ${tc.name}]:\n${resultStr}`);

          currentHistory.push({
            sender: 'assistant',
            text: `[Tool Call: ${tc.name}(${JSON.stringify(tc.args)})]`
          });
          currentHistory.push({
            sender: 'user',
            text: `[Tool Result for ${tc.name}]: ${resultStr.length > 2000 ? resultStr.slice(0, 2000) + '...' : resultStr}`
          });
        }

        const contextStr = truncateContextCleanly(toolSummaries.join('\n\n'), 15000);
        userMessage = `User Question: "${originalUserQuery}"\n\nRetrieved Documentation Context:\n${contextStr}\n\nBased strictly on the documentation search results above, answer the user's question directly with concise explanations, exact commands, and clickable Markdown links. Do not repeat introductory greetings.`;
        allowTools = false;
        continue;
      }

      // Handle SSE Streaming Reader
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let streamReplyText = '';
      const sseToolCalls: any[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;

          if (trimmed.startsWith('data:')) {
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === '[DONE]') continue;

            try {
              const dataObj = JSON.parse(dataStr);
              if (dataObj.status) {
                callbacks.onStatus?.(dataObj.status);
                this.emit('status', dataObj.status);
              }
              if (dataObj.tool_calls && Array.isArray(dataObj.tool_calls)) {
                sseToolCalls.push(...dataObj.tool_calls);
              }
              if (dataObj.delta) {
                streamReplyText += dataObj.delta;
                if (!allowTools) {
                  callbacks.onChunk?.(dataObj.delta);
                  this.emit('chunk', dataObj.delta);
                }
              }
              if (dataObj.text) {
                streamReplyText = dataObj.text;
                if (!allowTools) {
                  callbacks.onChunk?.(dataObj.text);
                  this.emit('chunk', dataObj.text);
                }
              }
            } catch {
              // Plain text stream line
              streamReplyText += dataStr;
              if (!allowTools) {
                callbacks.onChunk?.(dataStr);
                this.emit('chunk', dataStr);
              }
            }
          }
        }
      }

      if (!streamReplyText && buffer.trim()) {
        try {
          const parsedBuf = JSON.parse(buffer.trim());
          streamReplyText = parsedBuf.text || parsedBuf.reply || parsedBuf.message || buffer.trim();
          if (parsedBuf.tool_calls && Array.isArray(parsedBuf.tool_calls)) {
            sseToolCalls.push(...parsedBuf.tool_calls);
          }
        } catch {
          streamReplyText = buffer.trim();
        }
      }

      const parsed = parseAssistantOutput(streamReplyText);

      const toolCallsToExecute: Array<{ id: string; name: string; args: any }> = [];
      if (sseToolCalls.length > 0) {
        for (const tc of sseToolCalls) {
          toolCallsToExecute.push({
            id: tc.id || `call_${Date.now()}`,
            name: tc.name || tc.function?.name,
            args: typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : (tc.arguments || tc.args || {})
          });
        }
      } else if (parsed.extractedToolCalls.length > 0) {
        for (const tc of parsed.extractedToolCalls) {
          toolCallsToExecute.push({
            id: `call_${Date.now()}`,
            name: tc.name,
            args: tc.args || {}
          });
        }
      }

      if (toolCallsToExecute.length === 0) {
        finalReply = parsed.cleanText || streamReplyText || 'No response returned.';
        if (allowTools) {
          callbacks.onChunk?.(finalReply);
          this.emit('chunk', finalReply);
        }
        break;
      }

      // Ensure original user question is present in history before tool logs
      if (currentHistory.length === 0 || currentHistory[currentHistory.length - 1]?.text !== originalUserQuery) {
        currentHistory.push({
          sender: 'user',
          text: originalUserQuery
        });
      }

      const toolSummaries: string[] = [];
      for (const tc of toolCallsToExecute) {
        const statusInfo = getToolStatusInfo(tc.name, tc.args);
        callbacks.onStatus?.(statusInfo);
        this.emit('status', statusInfo);

        callbacks.onToolCall?.({ name: tc.name, args: tc.args, callId: tc.id });
        this.emit('tool_call', { name: tc.name, args: tc.args, callId: tc.id });

        const result = await this.executeTool(tc.name, tc.args);
        callbacks.onToolResult?.({ name: tc.name, args: tc.args, result, callId: tc.id });
        this.emit('tool_result', { name: tc.name, args: tc.args, result, callId: tc.id });

        const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        toolSummaries.push(`[Search Result for ${tc.name}]:\n${resultStr}`);

        currentHistory.push({
          sender: 'assistant',
          text: `[Tool Call: ${tc.name}(${JSON.stringify(tc.args)})]`
        });
        currentHistory.push({
          sender: 'user',
          text: `[Tool Result for ${tc.name}]: ${resultStr.length > 2000 ? resultStr.slice(0, 2000) + '...' : resultStr}`
        });
      }

      const contextStr = truncateContextCleanly(toolSummaries.join('\n\n'), 15000);
      userMessage = `User Question: "${originalUserQuery}"\n\nRetrieved Documentation Context:\n${contextStr}\n\nBased strictly on the documentation search results above, answer the user's question directly with concise explanations, exact commands, and clickable Markdown links. Do not repeat introductory greetings.`;
      allowTools = false;
      continue;
    }

    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: finalReply || 'No response returned.',
      sender: 'assistant',
      timestamp: Date.now()
    };
    this.addMessage(assistantMsg);
    this.emit('message', assistantMsg);

    return {
      message: finalReply,
      role: 'assistant',
      history: this.getHistory()
    };
  }

  // --- Tool Execution Pipeline ---

  // Stopwords to strip from multi-word search queries before splitting into individual keywords
  private static SEARCH_STOPWORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall',
    'should', 'may', 'might', 'must', 'can', 'could', 'to', 'of', 'in',
    'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
    'during', 'before', 'after', 'above', 'below', 'between', 'out',
    'up', 'down', 'off', 'over', 'under', 'again', 'further', 'then',
    'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all',
    'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some',
    'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than',
    'too', 'very', 'just', 'because', 'but', 'and', 'or', 'if', 'while',
    'about', 'what', 'which', 'who', 'whom', 'this', 'that', 'these',
    'those', 'am', 'it', 'its', 'i', 'me', 'my', 'we', 'our', 'you',
    'your', 'he', 'she', 'they', 'them', 'his', 'her', 'their'
  ]);

  public async executeTool(name: string, rawArgs: any): Promise<any> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { error: `Tool "${name}" is not registered on this assistant engine.` };
    }

    const handler = tool.handler || tool.execute;
    if (!handler) {
      return { error: `Tool "${name}" has no valid execution handler.` };
    }

    let args = rawArgs;
    if (typeof rawArgs === 'string') {
      try {
        args = JSON.parse(rawArgs);
      } catch {
        args = { query: rawArgs, path: rawArgs, code: rawArgs };
      }
    }
    if (!args || typeof args !== 'object') {
      args = {};
    }
    if (!args.query && (args.q || args.search_query || args.text || args.input || args.keyword || args.keywords)) {
      args.query = args.q || args.search_query || args.text || args.input || args.keyword || args.keywords;
    }

    // Keyword-splitting safety net for search tools
    if (name === 'search_documentation' && args.query && typeof args.query === 'string') {
      const rawQuery = args.query.trim();
      const words = rawQuery.toLowerCase().replace(/[^\w\s-]/g, '').split(/\s+/).filter(Boolean);
      const keywords = words.filter((w: string) => w.length > 2 && !DocmdAssistantEngine.SEARCH_STOPWORDS.has(w));

      // If 3+ meaningful keywords, split into individual searches and merge
      if (keywords.length >= 3) {
        const allResults: any[] = [];
        const seenPaths = new Set<string>();

        for (const keyword of keywords.slice(0, 5)) {
          try {
            const result = await handler({ ...args, query: keyword }, { engine: this });
            if (Array.isArray(result)) {
              for (const item of result) {
                const key = item.path || item.url || item.title || JSON.stringify(item);
                if (!seenPaths.has(key)) {
                  seenPaths.add(key);
                  allResults.push(item);
                }
              }
            }
          } catch { /* continue to next keyword */ }
        }

        return allResults.length > 0 ? allResults.slice(0, 8) : [];
      }
    }

    try {
      const result = await handler(args, { engine: this });
      return result;
    } catch (err: any) {
      console.warn(`[docmd-assistant] Tool execution failed for "${name}":`, err);
      this.emit('error', { tool: name, error: err });
      return { error: `Tool execution failed: ${err.message || String(err)}` };
    }
  }
}