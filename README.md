<div align="center">

  <!-- PROJECT TITLE -->
  <h3>
    <a href="https://docmd.io/assistant">
      docmd-assistant
    </a>
  </h3>
  
  <!-- ONE LINE SUMMARY -->
  <p>
    <b>Universal headless AI Assistant engine for documentation.</b>
    <br/>
    Multi-provider LLM support, client tool execution, and custom relay support.
  </p>
  
  <!-- BADGES -->
  <p>
    <a href="https://www.npmjs.com/package/docmd-assistant"><img src="https://img.shields.io/npm/v/docmd-assistant.svg?style=flat-square&color=CB3837" alt="npm version"></a>
    <a href="https://www.npmjs.com/package/docmd-assistant?activeTab=versions"><img src="https://img.shields.io/npm/dm/docmd-assistant.svg?style=flat-square&color=38bd24" alt="downloads"></a>
    <a href="https://github.com/docmd-io/docmd-assistant"><img src="https://img.shields.io/github/stars/docmd-io/docmd-assistant?style=flat-square&logo=github" alt="stars"></a>
    <a href="https://github.com/docmd-io/docmd-assistant/blob/main/LICENSE"><img src="https://img.shields.io/github/license/docmd-io/docmd-assistant.svg?style=flat-square&color=A31F34" alt="license"></a>
  </p>

  <!-- MENU -->
  <p>
    <h4>
      <a href="https://docmd.io/assistant/">Website</a> • 
      <a href="https://docs.docmd.io/assistant/">Documentation</a> • 
      <a href="https://github.com/docmd-io/docmd-assistant/issues">Report Bug</a>
    </h4>
  </p>

</div>

## Quick Start

**Install docmd-assistant via npm:**

```bash
npm install docmd-assistant
```

**Initialise the AI engine in your application:**

```typescript
import { DocmdAssistantEngine } from 'docmd-assistant';

const assistant = new DocmdAssistantEngine({
  provider: 'openai',
  model: 'gpt-4o-mini',
  apiKey: process.env.OPENAI_API_KEY,
  systemPrompt: 'You are a technical documentation assistant.'
});

const response = await assistant.sendMessage('How do I configure routing?');
console.log(response.message);
```

## Features

Designed to be 100% UI-agnostic, headless, and lightweight.

### Multi-Provider Multi-Model Support

* Powered directly by `aiplug` multi-provider runtime
* Supports OpenAI, Anthropic, Gemini, DeepSeek, Groq, MiniMax, Ollama, and more
* Hot-swappable providers and models at runtime

### Extensible Tool Execution

* Register custom client-side or server-side tools
* Native execution pipeline for document search, page navigation, and code copying
* Dynamic tool registration surface (`registerTool`, `unregisterTool`)

### Headless & UI-Agnostic

* Pure logic engine with no hardcoded DOM elements or mandatory UI
* Embed into React, Vue, Svelte, Angular, Vanilla JS, Node.js servers, or CLI tools
* Event-driven architecture with subscriptions for message, tool, and error events

### Custom Relay Support

* Connect directly via local provider API keys or proxy through custom relay endpoints
* Seamless integration with docmd Cloud AI Relay backend

## How It Works

```
Application Layer (React / Vue / Custom UI / CLI)
─────────────────────────────────────────────────
 1. Call assistant.sendMessage("query")
    → Emits 'message' event to UI
 2. Headless Engine processes turn:
    ├─ Direct Mode (aiplug)   → Interacts with OpenAI / Claude / Gemini / Ollama
    └─ Relay Mode (Cloud API) → Proxies securely via relay endpoint
 3. Tool Calling Pipeline:
    ├─ LLM triggers registered tool (e.g. search_documentation)
    ├─ Engine executes handler & appends context
    └─ Final response returned & 'message' event fired
```

## Programmatic Usage

### Registering Custom Tools

```typescript
import { DocmdAssistantEngine } from 'docmd-assistant';

const assistant = new DocmdAssistantEngine({
  provider: 'anthropic',
  model: 'claude-3-5-haiku-20241022',
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Register custom tool
assistant.registerTool({
  name: 'lookup_user_account',
  description: 'Retrieve user details by email address',
  parameters: {
    type: 'object',
    properties: {
      email: { type: 'string', description: 'User email address' }
    },
    required: ['email']
  },
  execute: async ({ email }) => {
    return { accountId: 'acc_12345', plan: 'pro', status: 'active' };
  }
});
```

### Subscribing to Engine Events

```typescript
assistant.on('message', (event) => {
  console.log(`[${event.data.role}]: ${event.data.content}`);
});

assistant.on('tool_call', (event) => {
  console.log(`Tool invoked: ${event.data.name}`, event.data.args);
});

assistant.on('error', (event) => {
  console.error('Assistant error:', event.data);
});
```

### Dynamic System Prompt Reinforcement

```typescript
assistant.setSystemPrompt('Act as a senior software architect.');
assistant.appendSystemPrompt('Always provide complete code snippets in TypeScript.');
```

## Configuration Options

| Option | Type | Description | Default |
| :--- | :--- | :--- | :--- |
| `provider` | `string` | AI Provider name | `'openai'` |
| `model` | `string` | Model identifier | `'gpt-4o-mini'` |
| `apiKey` | `string` | Direct provider API key | `undefined` |
| `baseURL` | `string` | Custom API gateway URL | `undefined` |
| `relayUrl` | `string` | Relay endpoint URL | `undefined` |
| `systemPrompt` | `string` | System instruction prompt | Default prompt |
| `history` | `ChatMessage[]` | Initial conversation history | `[]` |
| `tools` | `AssistantTool[]` | Array of initial tools | `[]` |

## Project Structure

Keeps the codebase modular, typed, and clean.

```
docmd-assistant/
├── dist/                  # Compiled ESM and CJS bundles
├── src/
│   ├── engine.ts          # Core DocmdAssistantEngine class & event pipeline
│   ├── index.ts           # Barrel module exports
│   ├── tools/
│   │   └── index.ts       # Standard documentation & navigation tools
│   └── types.ts           # TypeScript interfaces and event schemas
├── build.js               # Dual ESM/CJS esbuild bundler
├── package.json           # Package manifest
└── tsconfig.json          # TypeScript compiler configuration
```

## Part of the docmd ecosystem

`docmd-assistant` works standalone with any project or web framework. It also powers AI capabilities across [docmd](https://docmd.io) documentation tools.

| Tool | What it does |
| :--- | :----------- |
| [docmd](https://github.com/docmd-io/docmd) | Zero-config documentation engine |
| [docmd-search](https://github.com/docmd-io/docmd-search) | Offline semantic search engine |
| **docmd-assistant** | Universal headless AI Assistant engine |

## Community & Support

* Contributions are welcome
* If you find it useful, consider [sponsoring](https://github.com/sponsors/mgks) or starring the repo ⭐

## License

MIT License. See `LICENSE` for details.
