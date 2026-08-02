import {
  AssistantOptions,
  AssistantTool,
  ChatMessage,
  ChatResponse,
  AssistantEventType,
  AssistantEvent,
  AssistantEventListener
} from './types.js';

export class DocmdAssistantEngine {
  private options: AssistantOptions;
  private history: ChatMessage[] = [];
  private tools: Map<string, AssistantTool> = new Map();
  private systemPrompt: string;
  private listeners: Map<AssistantEventType, Set<AssistantEventListener>> = new Map();

  constructor(options: AssistantOptions = {}) {
    this.options = { ...options };
    this.systemPrompt = options.systemPrompt || 'You are a helpful AI Documentation Assistant.';

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
    const userMsg: ChatMessage = {
      role: 'user',
      content,
      sender: 'user',
      timestamp: Date.now()
    };
    this.addMessage(userMsg);
    this.emit('message', userMsg);

    return this.runConversationTurn(overrideOptions);
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
      const provider = opts.provider || 'openai';
      const model = opts.model || 'gpt-4o-mini';

      const { createLLMAdapter } = await import('aiplug');
      const adapter = createLLMAdapter({
        provider,
        model,
        apiKey: opts.apiKey || '',
        baseURL: opts.baseURL
      });

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

      const res = await adapter.converse(formattedMessages);
      const replyText = res.message?.content || 'No response generated.';

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
      const payload = {
        projectId: opts.projectId,
        siteId: opts.projectId,
        message: this.history[this.history.length - 1]?.content || '',
        history: this.history.slice(0, -1).map(m => ({
          sender: m.sender || m.role,
          text: m.content
        })),
        systemPrompt: this.systemPrompt,
        provider: opts.provider,
        model: opts.model
      };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Docmd-Plugin': 'docmd-assistant/0.1.0',
          ...(opts.headers || {})
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || `Relay error (${res.status})`);
      }

      const replyText = data.reply || data.response || data.message || 'No response returned.';

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