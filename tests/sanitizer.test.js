import assert from 'node:assert';
import { parseAssistantOutput, cleanAssistantReply } from '../dist/index.js';

console.log('Running docmd-assistant sanitizer test suite...');

const knownTools = ['search_documentation', 'get_site_structure', 'read_documentation_page'];

// Test 1: Standard documentation response with JSON codeblock containing `name` and `version`
{
  const raw = `Here is how to configure your project in package.json:

\`\`\`json
{
  "name": "@my-org/my-docs",
  "version": "1.0.0",
  "dependencies": {
    "@docmd/core": "^0.9.3"
  }
}
\`\`\`

You can now run \`npm install\` to get started.`;

  const parsed = parseAssistantOutput(raw, knownTools);
  assert.strictEqual(parsed.extractedToolCalls.length, 0, 'Should not extract package.json as tool call');
  assert(parsed.cleanText.includes('"name": "@my-org/my-docs"'), 'Should preserve package.json codeblock in cleanText');
  assert(parsed.cleanText.includes('npm install'), 'Should preserve trailing prose');
}

// Test 2: Natural prose containing "Action:", "Call:", "Tool:"
{
  const raw = `Recommended Action: restart your dev server after modifying docmd.config.json.
Next Call: verify the endpoint at https://api.docmd.io.
Primary Tool: use docmd build to generate static files.`;

  const parsed = parseAssistantOutput(raw, knownTools);
  assert.strictEqual(parsed.extractedToolCalls.length, 0, 'Should not extract natural prose keywords as tool calls');
  assert(parsed.cleanText.includes('Recommended Action: restart'), 'Should preserve Action prose');
  assert(parsed.cleanText.includes('Next Call: verify'), 'Should preserve Call prose');
  assert(parsed.cleanText.includes('Primary Tool: use'), 'Should preserve Tool prose');
}

// Test 3: Legitimate bracket-style tool call matching registered tool
{
  const raw = `I will search the documentation for you.
[TOOL_CALL: search_documentation(query="install")]`;

  const parsed = parseAssistantOutput(raw, knownTools);
  assert.strictEqual(parsed.extractedToolCalls.length, 1, 'Should extract registered tool call');
  assert.strictEqual(parsed.extractedToolCalls[0].name, 'search_documentation');
  assert.strictEqual(parsed.extractedToolCalls[0].args.query, 'install');
  assert(!parsed.cleanText.includes('TOOL_CALL'), 'Should strip tool call syntax from cleanText');
}

// Test 4: Legitimate XML/tag style tool call matching registered tool
{
  const raw = `<invoke name="search_documentation">{"query": "docker deployment"}</invoke>
Please wait while I retrieve the deployment guide.`;

  const parsed = parseAssistantOutput(raw, knownTools);
  assert.strictEqual(parsed.extractedToolCalls.length, 1, 'Should extract XML tool call');
  assert.strictEqual(parsed.extractedToolCalls[0].name, 'search_documentation');
  assert.strictEqual(parsed.extractedToolCalls[0].args.query, 'docker deployment');
  assert(parsed.cleanText.includes('Please wait while I retrieve'), 'Should keep human-facing prose');
  assert(!parsed.cleanText.includes('invoke'), 'Should strip invoke tag');
}

// Test 5: Unregistered XML tag in documentation should be preserved
{
  const raw = `In GitHub Actions, you define an action step:
<action name="build-step">npm run build</action>
This builds the site.`;

  const parsed = parseAssistantOutput(raw, knownTools);
  assert.strictEqual(parsed.extractedToolCalls.length, 0, 'Should not extract unregistered action tag');
  assert(parsed.cleanText.includes('<action name="build-step">'), 'Should preserve documentation XML tag');
}

// Test 6: Thinking / reasoning block stripping
{
  const raw = `<think>The user wants to know about configuration options. I should search for config.</think>
To configure docmd, edit your \`docmd.config.json\` file.`;

  const parsed = parseAssistantOutput(raw, knownTools);
  assert.strictEqual(parsed.thinking, 'The user wants to know about configuration options. I should search for config.');
  assert.strictEqual(parsed.cleanText, 'To configure docmd, edit your `docmd.config.json` file.');
}

// Test 7: Fallback when response contains only thinking
{
  const raw = `<think>Here is the direct answer explaining the topic.</think>`;
  const parsed = parseAssistantOutput(raw, knownTools);
  assert.strictEqual(parsed.cleanText, 'Here is the direct answer explaining the topic.');
}

// Test 8: Structured JSON tool call block in markdown codeblock
{
  const raw = `\`\`\`tool_call
{
  "name": "search_documentation",
  "arguments": { "query": "plugins" }
}
\`\`\``;

  const parsed = parseAssistantOutput(raw, knownTools);
  assert.strictEqual(parsed.extractedToolCalls.length, 1);
  assert.strictEqual(parsed.extractedToolCalls[0].name, 'search_documentation');
  assert.strictEqual(parsed.extractedToolCalls[0].args.query, 'plugins');
  assert.strictEqual(parsed.cleanText, '');
}

// Test 9 (Issue #222): Standard 3-backtick block is upgraded to 4-backtick fence by default
{
  const raw = `Here is the configuration example:

\`\`\`yaml
# docmd.config.yaml
assistant:
  enabled: true
\`\`\`

Save this file to proceed.`;

  const parsed = parseAssistantOutput(raw, knownTools);
  assert(parsed.cleanText.includes('````yaml'), 'Should upgrade opening fence to 4 backticks');
  assert(parsed.cleanText.includes('\n````\n'), 'Should upgrade closing fence to 4 backticks');
  assert(parsed.cleanText.includes('assistant:\n  enabled: true'), 'Should preserve code content');
}

// Test 10 (Issue #222): Retain nested 3-backtick codeblock inside 4-backtick fence
{
  const raw = `Here is how to document a code block:

\`\`\`\`markdown
# Example
\`\`\`javascript
console.log("Hello from nested block");
\`\`\`
\`\`\`\`

End of example.`;

  const parsed = parseAssistantOutput(raw, knownTools);
  assert(parsed.cleanText.includes('````markdown'), 'Outer block remains 4 backticks');
  assert(parsed.cleanText.includes('```javascript\nconsole.log("Hello from nested block");\n```'), 'Nested 3-backtick block preserved completely without collision');
}

// Test 11 (Issue #222): Inner content containing 4-backticks elevates outer fence to 5-backticks
{
  const raw = `\`\`\`text
Line 1: code snippet with \`\`\`\` inside
Line 2
\`\`\``;

  const parsed = parseAssistantOutput(raw, knownTools);
  assert(parsed.cleanText.includes('`````text'), 'Should elevate outer opening fence to 5 backticks');
  assert(parsed.cleanText.endsWith('`````'), 'Should elevate outer closing fence to 5 backticks');
  assert(parsed.cleanText.includes('````'), 'Should preserve inner 4-backtick sequence');
}

// Test 12: Standard code block always uses 4 backticks
{
  const raw = `\`\`\`bash
# Run command
pnpm test
\`\`\``;

  const parsed = parseAssistantOutput(raw, knownTools);
  assert(parsed.cleanText.startsWith('````bash'), 'Code block uses 4 backticks');
  assert(parsed.cleanText.endsWith('````'), 'Code block closes with 4 backticks');
}

// Test 13 (Issue #222): Inline code spans are untouched
{
  const raw = `Use the \`docmd build\` command and \`npm install\` to get started.`;

  const parsed = parseAssistantOutput(raw, knownTools);
  assert.strictEqual(parsed.cleanText, `Use the \`docmd build\` command and \`npm install\` to get started.`);
}

console.log('✅ All 13 sanitizer & 4-backtick code fence unit tests passed successfully!');
