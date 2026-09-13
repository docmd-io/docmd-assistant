import assert from 'node:assert';
import http from 'node:http';
import { DocmdAssistantEngine } from '../dist/index.js';

console.log('Running DocmdAssistantEngine relay & prompt test suite...');

let recordedRequests = [];
let mockResponses = [];

const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }
  const parsedBody = body ? JSON.parse(body) : {};
  recordedRequests.push(parsedBody);

  const nextResp = mockResponses.shift() || { text: 'Default mock answer.' };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(nextResp));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const endpoint = `http://127.0.0.1:${address.port}/ai/chat`;

try {
  // Test 1: Navigation ordering query with tool execution and follow-up prompt verification
  {
    recordedRequests = [];
    mockResponses = [
      {
        tool_calls: [
          {
            id: 'call_nav_1',
            name: 'search_documentation',
            arguments: JSON.stringify({ query: 'pin md file top navigation' })
          }
        ]
      },
      {
        text: 'No documentation page explicitly covers a dedicated pinning flag for auto-generated navigation. However, you can control navigation order by creating an explicit `navigation.json` where your desired file is placed first.'
      }
    ];

    const engine = new DocmdAssistantEngine({
      endpoint,
      projectId: 'test-project'
    });

    engine.registerTool({
      name: 'search_documentation',
      description: 'Search documentation pages',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
      execute: async ({ query }) => {
        return [
          {
            title: 'Multi-Project Workspaces',
            url: '/configuration/workspaces/',
            snippet: 'Project-level navigation.json takes top priority over auto-generated sidebars.'
          },
          {
            title: 'Zero-Config Architecture',
            url: '/configuration/zero-config/',
            snippet: 'Zero-config discovers markdown files alphabetically by default.'
          }
        ];
      }
    });

    const res = await engine.sendMessage('How can I have a .md file always appear at the top of navigation?');

    assert(res.message, 'Response message must not be empty');
    assert(res.message.includes('explicit `navigation.json`'), 'Should synthesize navigation.json approach');
    assert.strictEqual(recordedRequests.length, 2, 'Should have made 2 requests (turn 1 tool call, turn 2 synthesis)');

    const turn2Message = recordedRequests[1].message;
    assert(turn2Message.includes('If the documentation does not have an explicit, dedicated configuration option'), 'Turn 2 prompt must instruct architectural synthesis');
    assert(turn2Message.includes('Never return an empty response'), 'Turn 2 prompt must forbid empty response');
    assert(turn2Message.includes('Multi-Project Workspaces'), 'Turn 2 prompt must include retrieved context');
    console.log('✅ Test 1 Passed: Navigation ordering query with tool execution and prompt verification');
  }

  // Test 2: Fallback when LLM returns empty text with thinking tags
  {
    recordedRequests = [];
    mockResponses = [
      {
        tool_calls: [
          {
            id: 'call_search_2',
            name: 'search_documentation',
            arguments: JSON.stringify({ query: 'postgres auth login' })
          }
        ]
      },
      {
        text: '<think>The search returned no results for PostgreSQL or user authentication. docmd is a static site generator and does not support database logins.</think>'
      }
    ];

    const engine = new DocmdAssistantEngine({
      endpoint,
      projectId: 'test-project'
    });

    engine.registerTool({
      name: 'search_documentation',
      description: 'Search docs',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
      execute: async () => []
    });

    const res = await engine.sendMessage('How do I connect docmd to PostgreSQL for user authentication?');
    assert(res.message, 'Response message must not be empty even if model only emitted thought');
    assert(res.message.includes('docmd is a static site generator') || res.message.includes('No documentation page'), 'Should fallback to thought reasoning or helpful notice');
    console.log('✅ Test 2 Passed: Fallback when model emits thought tags without clean text');
  }

  // Test 3: Multi-turn tool execution across multiple tools (search + get_site_structure)
  {
    recordedRequests = [];
    mockResponses = [
      {
        tool_calls: [
          {
            id: 'call_s1',
            name: 'search_documentation',
            arguments: JSON.stringify({ query: 'custom dark theme colors' })
          }
        ]
      },
      {
        tool_calls: [
          {
            id: 'call_s2',
            name: 'get_site_structure',
            arguments: {}
          }
        ]
      },
      {
        text: 'You can configure custom dark theme colors using CSS variables in your `custom.css`.'
      }
    ];

    const engine = new DocmdAssistantEngine({
      endpoint,
      projectId: 'test-project'
    });

    engine.registerTool({
      name: 'search_documentation',
      description: 'Search docs',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
      execute: async () => [{ title: 'Custom CSS', url: '/theming/custom-css-js/' }]
    });

    engine.registerTool({
      name: 'get_site_structure',
      description: 'Site structure',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ versions: ['v0.9.6'], themes: ['default', 'summer'] })
    });

    const res = await engine.sendMessage('How do I customize the dark mode theme colors?');
    assert(res.message.includes('CSS variables in your `custom.css`'), 'Should synthesize after multi-turn tools');
    assert.strictEqual(recordedRequests.length, 3, 'Should execute 2 tool turns before synthesis');

    const turn3Message = recordedRequests[2].message;
    assert(turn3Message.includes('Custom CSS'), 'Turn 3 must include tool 1 context');
    assert(turn3Message.includes('get_site_structure'), 'Turn 3 must include tool 2 context');
    console.log('✅ Test 3 Passed: Multi-turn tool execution accumulates context correctly');
  }

  // Test 4: Pure empty response from relay triggers informative fallback
  {
    recordedRequests = [];
    mockResponses = [
      { text: '' }
    ];

    const engine = new DocmdAssistantEngine({
      endpoint,
      projectId: 'test-project'
    });

    const res = await engine.sendMessage('What is an unknown feature xyz?');
    assert(res.message, 'Response message must never be empty');
    assert(res.message.includes('No documentation page in the retrieved search results explicitly covers a dedicated setting'), 'Should provide informative fallback');
    console.log('✅ Test 4 Passed: Pure empty response triggers informative fallback');
  }

  console.log('\n🎉 ALL DocmdAssistantEngine relay & prompt tests PASSED successfully!\n');
} finally {
  server.close();
}
