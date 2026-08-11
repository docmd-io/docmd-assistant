/**
 * Universal, Provider-Agnostic LLM Output Sanitizer & Tool Parser.
 * Handles reasoning/thinking blocks, structured & text-based tool calls,
 * and internal tokens across all major AI providers without hardcoding.
 */

export interface ParsedAssistantOutput {
  cleanText: string;
  thinking?: string;
  extractedToolCalls: Array<{
    name: string;
    args: Record<string, any>;
  }>;
}

export function parseAssistantOutput(raw: string): ParsedAssistantOutput {
  if (!raw || typeof raw !== 'string') {
    return { cleanText: '', extractedToolCalls: [] };
  }

  let text = raw;
  let thinkingParts: string[] = [];
  const extractedToolCalls: Array<{ name: string; args: Record<string, any> }> = [];

  // 1. Extract and strip Thinking / Reasoning blocks (Universal XML & Markdown tags)
  // Handles: <think>, <thought>, <reasoning>, <reflection>, <plan>, <*:think>, <*:thought>, etc.
  const thinkingRegex = /<(?:[a-zA-Z0-9_\-]+:)?(think|thought|reasoning|reflection|plan)\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_\-]+:)?\1>/gi;
  text = text.replace(thinkingRegex, (_match, _tag, content) => {
    if (content.trim()) thinkingParts.push(content.trim());
    return '';
  });

  // Markdown codeblock thinking: ```thought ... ``` or ```thinking ... ```
  const mdThinkingRegex = /```(?:thought|thinking|reasoning|reflection)\s*\n([\s\S]*?)```/gi;
  text = text.replace(mdThinkingRegex, (_match, content) => {
    if (content.trim()) thinkingParts.push(content.trim());
    return '';
  });

  // Bracket wrappers like [thought: ...] or [thinking: ...]
  const bracketThinkingRegex = /\[(?:thought|thinking|reasoning):\s*([\s\S]*?)\]/gi;
  text = text.replace(bracketThinkingRegex, (_match, content) => {
    if (content.trim()) thinkingParts.push(content.trim());
    return '';
  });

  // Provider-specific internal bracket delimiters like ]<]...[>[
  text = text.replace(/\]<\][a-zA-Z0-9_\-]+\[>\[[\s\S]*?(?:<\/(?:request|tool_call|action)>|\]<\][a-zA-Z0-9_\-]+\[>\[|$)/gi, '');
  text = text.replace(/\]<\][a-zA-Z0-9_\-]+\[>\[/gi, '');

  // Strip dangling/unclosed thinking tags (e.g. at the start or end of stream)
  text = text.replace(/<\/?(?:[a-zA-Z0-9_\-]+:)?(?:think|thought|reasoning|reflection|plan)\b[^>]*>/gi, '');

  // 2. Extract and strip Structured Tool Calls in XML / Tag format
  // Handles: <tool_call>, <function_call>, <tool>, <action>, <request>
  const toolTagRegex = /<(?:[a-zA-Z0-9_\-]+:)?(tool_call|function_call|tool|action|request)\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_\-]+:)?\1>/gi;
  text = text.replace(toolTagRegex, (_match, _tag, body) => {
    tryParseToolJson(body, extractedToolCalls);
    return '';
  });

  // Markdown codeblock tool calls: ```tool_call ... ``` or ```json:tool ... ```
  const mdToolRegex = /```(?:tool_call|function_call|tool|action|json:tool)\s*\n([\s\S]*?)```/gi;
  text = text.replace(mdToolRegex, (_match, body) => {
    tryParseToolJson(body, extractedToolCalls);
    return '';
  });

  // 3. Detect and extract inline JSON tool call objects (e.g. { "name": "search_documentation", "parameters": { ... } })
  const jsonObjectRegex = /\{\s*"(?:name|tool|action|function)"\s*:\s*"([^"]+)"\s*,\s*"(?:parameters|arguments|args|input)"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
  text = text.replace(jsonObjectRegex, (_match, toolName, argsJson) => {
    try {
      const args = JSON.parse(argsJson);
      extractedToolCalls.push({ name: toolName.trim(), args });
      return '';
    } catch {
      return _match;
    }
  });

  // Strip any remaining dangling tool tags
  text = text.replace(/<\/?(?:[a-zA-Z0-9_\-]+:)?(?:tool_call|function_call|tool|action|request)\b[^>]*>/gi, '');

  const cleanText = text.trim();
  const thinking = thinkingParts.length > 0 ? thinkingParts.join('\n\n') : undefined;

  return {
    cleanText,
    thinking,
    extractedToolCalls
  };
}

function tryParseToolJson(rawJson: string, targetArray: Array<{ name: string; args: Record<string, any> }>): void {
  const trimmed = rawJson.trim();
  if (!trimmed) return;

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      const name = parsed.name || parsed.tool || parsed.action || parsed.function;
      const args = parsed.parameters || parsed.arguments || parsed.args || parsed.input || {};
      if (name && typeof name === 'string') {
        targetArray.push({
          name: name.trim(),
          args: typeof args === 'string' ? JSON.parse(args) : args
        });
      }
    }
  } catch {
    // If not direct JSON, scan for nested JSON inside
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const nested = JSON.parse(match[0]);
        const name = nested.name || nested.tool || nested.action || nested.function;
        const args = nested.parameters || nested.arguments || nested.args || nested.input || {};
        if (name && typeof name === 'string') {
          targetArray.push({
            name: name.trim(),
            args: typeof args === 'string' ? JSON.parse(args) : args
          });
        }
      } catch { /* ignore parse failure */ }
    }
  }
}

export function cleanAssistantReply(raw: string): string {
  return parseAssistantOutput(raw).cleanText;
}