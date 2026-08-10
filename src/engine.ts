import {
  AssistantOptions,
  AssistantTool,
  ChatMessage,
  ChatResponse,
  AssistantEventType,
  AssistantEvent,
  AssistantEventListener
} from './types.js';

export const ENGINE_VERSION = typeof process !== 'undefined' && process.env?.ENGINE_VERSION ? process.env.ENGINE_VERSION : '0.1.9';

export function cleanAssistantReply(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/<mm:think>[\s\S]*?<\/mm:think>/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?(?:mm:)?think>/gi, '')
    .replace(/\]<\]minimax\[>\[[\s\S]*?\]<\]minimax\[>\[/gi, '')
    .replace(/\]<\]minimax\[>\[/gi, '')
    .replace(/<request>[\s\S]*?<\/request>/gi, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .trim();
}

export const DEFAULT_SYSTEM_PROMPT = `You are docmd assistant — a professional, precise, and concise technical AI assistant for this documentation site.

CRITICAL CONSTRAINTS & BEHAVIORAL RULES:
1. IDENTITY: Your name is "docmd assistant". You are an expert AI guide specifically for this documentation site.
2. STRICT SCOPE & BOUNDARIES: Answer strictly about the software, APIs, tools, installation, configuration, and topics documented on this site. Politely decline off-topic queries.
3. PROFESSIONAL & CONCISE: Provide direct, succinct, and professional answers. Do NOT use excessive emojis. Avoid conversational filler or boilerplate apologies. Get straight to the point.
4. AUTONOMOUS & PROACTIVE TOOL EXECUTION:
   - Always use your tools proactively. NEVER ask the user "Would you like me to search?" or "Should I check the site structure?". Directly execute the appropriate tool (\`search_documentation\` or \`get_site_structure\`) to retrieve accurate facts before answering.
   - Use \`get_site_structure\` to inspect site topology, available documentation branches, and navigation trees.
   - Use \`search_documentation\` to search release notes, API guides, configuration options, and concepts across all projects.
5. VERSION & RELEASE NOTES INTELLIGENCE:
   - The configured branch represents the documentation major/minor version (e.g. v0.9.x).
   - Patch releases (e.g. v0.9.1, v0.9.2) and changelog updates are documented in the release notes.
   - When asked what the latest release or version is, or what was introduced in a patch version, ALWAYS search the release notes using \`search_documentation\` (e.g. query: "release notes" or "0.9.1 release notes") to find the newest release before answering. Never state a release does not exist without searching.
6. HYPERLINKS & CITATIONS: Always include clickable Markdown hyperlinks \`[Page Title](path)\` in your response for referenced documentation pages.`;

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

  // --- Core Execution & Messaging ---

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

      return await this.runConversationTurn(overrideOptions);
    } finally {
      this.isExecuting = false;
    }
  }

  private async runConversationTurn(overrideOptions?: Partial<AssistantOptions>): Promise<ChatResponse> {
    const opts = { ...this.options, ...overrideOptions };
    const endpoint = opts.relayUrl || opts.endpoint;

    // Mode 1: Connect via Direct aiplug Engine when API Key is provided
    if (opts.apiKey || opts.provider === 'ollama') {
      return this.runAiplugTurn(opts);
    }

    // Mode 2: Connect via Relay Endpoint (e.g. Cloud Relay)
    return this.runRelayTurn(endpoint || 'https://api.docmd.io/v1/ai/chat', opts);
  }

  private async runAiplugTurn(opts: AssistantOptions): Promise<ChatResponse> {
    try {
      const reasoningVal = opts.reasoning ?? false;
      const adapterOptions: Record<string, any> = {
        apiKey: opts.apiKey || '',
        baseURL: opts.baseURL,
        ...(reasoningVal ? { options: { providerOptions: { reasoning: reasoningVal } } } : {})
      };
      if (opts.provider) adapterOptions.provider = opts.provider;
      if (opts.model) adapterOptions.model = opts.model;

      const { createLLMAdapter } = await import('aiplug');
      const adapter = createLLMAdapter(adapterOptions as any);

      const formattedMessages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }> = [
        { role: 'system', content: this.systemPrompt }
      ];

      for (const msg of this.history) {
        const role = (msg as any).sender || msg.role;
        formattedMessages.push({
          role: role === 'system' ? 'system' : role === 'assistant' ? 'assistant' : 'user',
          content: msg.content
        });
      }

      const registeredTools = this.getTools().map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters || (t as any).schema,
        execute: t.execute || (t as any).handler
      }));

      const res = await adapter.converse(formattedMessages, {
        tools: registeredTools.length > 0 ? registeredTools : undefined
      } as any);
      const rawReply = res.message?.content || 'No response generated.';
      const replyText = cleanAssistantReply(rawReply);

      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: replyText,
        sender: 'assistant',
        timestamp: Date.now()
      };
      this.addMessage(assistantMsg);
      this.emit('message', assistantMsg);

      return {
        message: replyText,
        role: 'assistant',
        history: this.getHistory()
      };
    } catch (err: any) {
      this.emit('error', err);
      throw err;
    }
  }

  private async runRelayTurn(endpoint: string, opts: AssistantOptions): Promise<ChatResponse> {
    try {
      const reasoningVal = opts.reasoning ?? false;
      const registeredTools = this.getTools().map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters || (t as any).schema
      }));

      const payload: Record<string, any> = {
        projectId: opts.projectId,
        siteId: opts.projectId,
        message: this.history[this.history.length - 1]?.content || '',
        pageUrl: typeof location !== 'undefined' ? location.href : undefined,
        pageTitle: typeof document !== 'undefined' ? document.title : undefined,
        history: this.history.slice(0, -1).map(m => ({
          sender: m.sender || m.role,
          text: m.content
        })),
        systemPrompt: this.systemPrompt,
        reasoning: reasoningVal,
        tools: registeredTools.length > 0 ? registeredTools : undefined
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

      // Handle client-side tool execution calls if returned by relay
      if (data.tool_calls && Array.isArray(data.tool_calls) && data.tool_calls.length > 0) {
        for (const tc of data.tool_calls) {
          const toolName = tc.name || tc.function?.name;
          const toolArgs = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : (tc.arguments || tc.args || {});
          const toolResult = await this.executeTool(toolName, toolArgs);
          
          try {
            const followUpRes = await fetch(endpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Docmd-Plugin': `docmd-assistant/${ENGINE_VERSION}`,
                ...(opts.headers || {})
              },
              body: JSON.stringify({
                ...payload,
                toolResult: { name: toolName, result: toolResult, callId: tc.id }
              })
            });
            const followUpData = await followUpRes.json();
            if (followUpData && (followUpData.reply || followUpData.message || followUpData.text || followUpData.response)) {
              data.reply = followUpData.reply || followUpData.message || followUpData.text || followUpData.response;
            }
          } catch { /* silent */ }
        }
      }

      const rawReply = data.text || data.reply || data.response || data.message || 'No response returned.';
      const replyText = cleanAssistantReply(rawReply);

      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: replyText,
        sender: 'assistant',
        timestamp: Date.now()
      };
      this.addMessage(assistantMsg);
      this.emit('message', assistantMsg);

      return {
        message: replyText,
        role: 'assistant',
        history: this.getHistory()
      };
    } catch (err: any) {
      this.emit('error', err);
      throw err;
    }
  }

  // --- Tool Execution Pipeline ---

  public async executeTool(name: string, args: any): Promise<any> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool "${name}" is not registered on this assistant engine.`);
    }

    const handler = tool.handler || tool.execute;
    if (!handler) {
      throw new Error(`Tool "${name}" has no valid execution handler.`);
    }

    this.emit('tool_call', { name, args });
    try {
      const result = await handler(args, { engine: this });
      this.emit('tool_result', { name, args, result });
      return result;
    } catch (err: any) {
      this.emit('error', { tool: name, error: err });
      throw err;
    }
  }
}