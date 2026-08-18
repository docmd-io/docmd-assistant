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

export function parseAssistantOutput(raw: string, knownToolNames?: string[]): ParsedAssistantOutput {
  if (!raw || typeof raw !== 'string') {
    return { cleanText: '', extractedToolCalls: [] };
  }

  let text = raw;
  const thinkingParts: string[] = [];
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
  // Handles: <tool_call>, <function_call>, <tool>, <action>, <request>, <invoke name="...">
  const toolTagRegex = /<(?:[a-zA-Z0-9_\-]+:)?(tool_call|function_call|tool|action|request|invoke)\b([^>]*)>([\s\S]*?)<\/(?:[a-zA-Z0-9_\-]+:)?\1>/gi;
  text = text.replace(toolTagRegex, (_match, _tag, attrs, body) => {
    // Check if tool name was specified in attributes, e.g. <invoke name="search_documentation">
    const nameMatch = attrs.match(/name=["']([^"']+)["']/i);
    if (nameMatch) {
      const toolName = nameMatch[1].trim();
      let args: Record<string, any> = {};
      try {
        args = JSON.parse(body.trim());
      } catch {
        args = { query: body.trim() };
      }
      extractedToolCalls.push({ name: toolName, args });
    } else {
      tryParseToolJson(body, extractedToolCalls);
    }
    return '';
  });

  // Handles inline tags like <function=search_documentation>{"query":"..."}</function>
  const inlineFunctionTagRegex = /<function\s*=\s*["']?([a-zA-Z0-9_\-]+)["']?>([\s\S]*?)<\/function>/gi;
  text = text.replace(inlineFunctionTagRegex, (_match, toolName, body) => {
    let args: Record<string, any> = {};
    try {
      args = JSON.parse(body.trim());
    } catch {
      args = { query: body.trim() };
    }
    extractedToolCalls.push({ name: toolName.trim(), args });
    return '';
  });

  // 3. Markdown codeblock tool calls: ```tool_call ... ``` or ```json:tool ... ``` or ```json with tool calls
  const mdToolRegex = /```(?:tool_call|function_call|tool|action|json:tool|json)?\s*\n([\s\S]*?)```/gi;
  text = text.replace(mdToolRegex, (_match, body) => {
    const initialCount = extractedToolCalls.length;
    tryParseToolJson(body, extractedToolCalls, knownToolNames);
    // If a tool call was extracted from this codeblock, remove the codeblock from clean output
    if (extractedToolCalls.length > initialCount) {
      return '';
    }
    return _match;
  });

  // 4. Bracket-style tool calls: [TOOL_CALL: search_documentation {"query": "..."}] or [TOOL: search_documentation(...)]
  const bracketToolRegex = /\[(?:TOOL_CALL|TOOL|CALL|ACTION):\s*([a-zA-Z0-9_\-]+)\s*([\s\S]*?)\]/gi;
  text = text.replace(bracketToolRegex, (_match, toolName, body) => {
    let args: Record<string, any> = {};
    const trimmedBody = body.trim();
    if (trimmedBody.startsWith('{') && trimmedBody.endsWith('}')) {
      try {
        args = JSON.parse(trimmedBody);
      } catch {
        args = { query: trimmedBody };
      }
    } else if (trimmedBody.startsWith('(') && trimmedBody.endsWith(')')) {
      args = parseFunctionalArgs(trimmedBody.slice(1, -1));
    } else {
      args = { query: trimmedBody };
    }
    extractedToolCalls.push({ name: toolName.trim(), args });
    return '';
  });

  // 5. Functional invocation notation: call:search_documentation{...} or search_documentation(query="...")
  if (knownToolNames && knownToolNames.length > 0) {
    for (const toolName of knownToolNames) {
      // Functional: search_documentation({"query": "..."}) or search_documentation(query="...")
      const funcRegex = new RegExp(`(?:call:)?\\b${toolName}\\s*\\(([\\s\\S]*?)\\)`, 'g');
      text = text.replace(funcRegex, (_match, innerArgs) => {
        let args: Record<string, any> = {};
        const trimmed = innerArgs.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          try {
            args = JSON.parse(trimmed);
          } catch {
            args = parseFunctionalArgs(trimmed);
          }
        } else {
          args = parseFunctionalArgs(trimmed);
        }
        extractedToolCalls.push({ name: toolName, args });
        return '';
      });
    }
  }

  // 6. Generic JSON tool call object search in remaining text
  // Scans for balanced JSON objects and checks if they represent tool invocations
  text = extractAndStripJsonObjects(text, extractedToolCalls, knownToolNames);

  // Strip any remaining dangling tool tags
  text = text.replace(/<\/?(?:[a-zA-Z0-9_\-]+:)?(?:tool_call|function_call|tool|action|request|invoke)\b[^>]*>/gi, '');

  // 7. Normalize fenced code blocks for consistent rendering
  text = text.replace(/```(\w+)(?:[ \t]+|\r?\n)?([\s\S]*?)```/g, (_match, lang, code) => {
    const trimmedCode = code.replace(/^\s*\n?/, '');
    return '```' + lang + '\n' + trimmedCode + '```';
  });

  let cleanText = text.trim();
  const thinking = thinkingParts.length > 0 ? thinkingParts.join('\n\n') : undefined;

  // Fallback: If stripping thinking tags left the answer empty, recover the thinking text as the response
  if (!cleanText && thinking) {
    cleanText = thinking;
  }

  return {
    cleanText,
    thinking,
    extractedToolCalls
  };
}

function parseFunctionalArgs(argStr: string): Record<string, any> {
  const trimmed = argStr.trim();
  if (!trimmed) return {};

  const result: Record<string, any> = {};
  // Match key="value" or key='value' or key=123 or key={...}
  const paramRegex = /([a-zA-Z0-9_\-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\{[^}]*\})|([a-zA-Z0-9_\-\.]+))/g;
  let match: RegExpExecArray | null;
  let matchedAny = false;

  while ((match = paramRegex.exec(trimmed)) !== null) {
    matchedAny = true;
    const key = match[1];
    const val = match[2] ?? match[3] ?? match[4] ?? match[5];
    if (val !== undefined) {
      if (val.startsWith('{') && val.endsWith('}')) {
        try {
          result[key] = JSON.parse(val);
        } catch {
          result[key] = val;
        }
      } else if (!isNaN(Number(val))) {
        result[key] = Number(val);
      } else if (val === 'true') {
        result[key] = true;
      } else if (val === 'false') {
        result[key] = false;
      } else {
        result[key] = val;
      }
    }
  }

  if (!matchedAny && trimmed) {
    result.query = trimmed.replace(/^["']|["']$/g, '');
  }

  return result;
}

function tryParseToolJson(
  rawJson: string,
  targetArray: Array<{ name: string; args: Record<string, any> }>,
  knownToolNames?: string[]
): boolean {
  const trimmed = rawJson.trim();
  if (!trimmed) return false;

  try {
    const parsed = JSON.parse(trimmed);
    return processParsedToolObject(parsed, targetArray, knownToolNames);
  } catch {
    // If not valid single JSON, scan for { ... } blocks inside
    let found = false;
    const matches = findBalancedJsonObjects(trimmed);
    for (const jsonStr of matches) {
      try {
        const parsed = JSON.parse(jsonStr);
        if (processParsedToolObject(parsed, targetArray, knownToolNames)) {
          found = true;
        }
      } catch { /* ignore */ }
    }
    return found;
  }
}

function processParsedToolObject(
  parsed: any,
  targetArray: Array<{ name: string; args: Record<string, any> }>,
  knownToolNames?: string[]
): boolean {
  if (!parsed || typeof parsed !== 'object') return false;

  // 1. Array of tool calls (OpenAI format): [ { name: "...", ... } ]
  if (Array.isArray(parsed)) {
    let matched = false;
    for (const item of parsed) {
      if (processParsedToolObject(item, targetArray, knownToolNames)) {
        matched = true;
      }
    }
    return matched;
  }

  // 2. Object with tool_calls array: { tool_calls: [...] }
  if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
    let matched = false;
    for (const tc of parsed.tool_calls) {
      if (processParsedToolObject(tc, targetArray, knownToolNames)) {
        matched = true;
      }
    }
    return matched;
  }

  // 3. Object with function wrapper: { type: "function", function: { name: "...", arguments: ... } }
  if (parsed.function && typeof parsed.function === 'object') {
    return processParsedToolObject(parsed.function, targetArray, knownToolNames);
  }

  // 4. Standard tool call object: { name: "...", arguments: ... } or { tool: "...", args: ... }
  const name = parsed.name || parsed.tool || parsed.action || parsed.function_name;
  let args = parsed.parameters || parsed.arguments || parsed.args || parsed.input || parsed.action_input;

  if (name && typeof name === 'string') {
    const toolName = name.trim();
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = { query: args };
      }
    } else if (!args || typeof args !== 'object') {
      args = {};
    }

    targetArray.push({ name: toolName, args });
    return true;
  }

  // 5. Named key format matching a known tool: { "search_documentation": { "query": "..." } }
  if (knownToolNames && knownToolNames.length > 0) {
    for (const toolName of knownToolNames) {
      if (parsed[toolName] !== undefined) {
        let toolArgs = parsed[toolName];
        if (typeof toolArgs === 'string') {
          try {
            toolArgs = JSON.parse(toolArgs);
          } catch {
            toolArgs = { query: toolArgs };
          }
        } else if (!toolArgs || typeof toolArgs !== 'object') {
          toolArgs = {};
        }
        targetArray.push({ name: toolName, args: toolArgs });
        return true;
      }
    }
  }

  return false;
}

function extractAndStripJsonObjects(
  text: string,
  targetArray: Array<{ name: string; args: Record<string, any> }>,
  knownToolNames?: string[]
): string {
  let result = text;
  const jsonBlocks = findBalancedJsonObjects(text);

  for (const block of jsonBlocks) {
    try {
      const parsed = JSON.parse(block);
      const initialCount = targetArray.length;
      if (processParsedToolObject(parsed, targetArray, knownToolNames)) {
        if (targetArray.length > initialCount) {
          result = result.replace(block, '');
        }
      }
    } catch {
      // not valid JSON, ignore
    }
  }

  return result;
}

function findBalancedJsonObjects(str: string): string[] {
  const results: string[] = [];
  let depth = 0;
  let startIndex = -1;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') {
        if (depth === 0) {
          startIndex = i;
        }
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0 && startIndex !== -1) {
          results.push(str.slice(startIndex, i + 1));
          startIndex = -1;
        }
      }
    }
  }

  return results;
}

export function cleanAssistantReply(raw: string): string {
  return parseAssistantOutput(raw).cleanText;
}