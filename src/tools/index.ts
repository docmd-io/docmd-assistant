import { AssistantTool, SearchResultItem } from '../types.js';

function extractStructuredContent(mainContent: Element): string {
  const clone = mainContent.cloneNode(true) as HTMLElement;

  // Remove non-content elements
  const removeSelectors = 'script, style, noscript, nav, aside, footer, header, svg, .sidebar, .toc, .docmd-ai-drawer, .docmd-ai-bar, [aria-hidden="true"]';
  clone.querySelectorAll(removeSelectors).forEach(el => el.remove());

  // Preserve pre/code blocks with indentation and newlines intact
  clone.querySelectorAll('pre').forEach((pre) => {
    const code = pre.querySelector('code');
    const lang = code?.className?.match(/language-([a-z0-9_-]+)/i)?.[1] || '';
    const codeText = (code || pre).textContent || '';
    const marker = document.createElement('div');
    marker.textContent = `\n\n\`\`\`${lang}\n${codeText.trim()}\n\`\`\`\n\n`;
    pre.replaceWith(marker);
  });

  // Convert headings
  for (let lvl = 1; lvl <= 6; lvl++) {
    const hashes = '#'.repeat(lvl);
    clone.querySelectorAll(`h${lvl}`).forEach(h => {
      const t = (h.textContent || '').trim();
      if (t) {
        const div = document.createElement('div');
        div.textContent = `\n\n${hashes} ${t}\n\n`;
        h.replaceWith(div);
      }
    });
  }

  // Convert list items
  clone.querySelectorAll('li').forEach(li => {
    const t = (li.textContent || '').trim();
    if (t) {
      const div = document.createElement('div');
      div.textContent = `\n- ${t}`;
      li.replaceWith(div);
    }
  });

  // Convert paragraphs
  clone.querySelectorAll('p').forEach(p => {
    const t = (p.textContent || '').trim();
    if (t) {
      const div = document.createElement('div');
      div.textContent = `\n\n${t}\n\n`;
      p.replaceWith(div);
    }
  });

  const raw = clone.textContent || '';
  return raw.replace(/\n{3,}/g, '\n\n').trim();
}

export function createStandardTools(
  customSearch?: (query: string, project?: string, version?: string) => Promise<SearchResultItem[]>,
  customReader?: (path: string) => Promise<string | { title?: string; content: string }>
): AssistantTool[] {
  return [
    {
      name: 'search_documentation',
      description: 'Search documentation content for answers to specific user questions. Optionally filter by version or project.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query string' },
          version: { type: 'string', description: 'Optional documentation version filter (e.g. "0.9.0", "0.8.0", "latest")' },
          project: { type: 'string', description: 'Optional workspace project name or prefix filter (e.g. "/", "assistant", "search")' }
        },
        required: ['query']
      },
      execute: async (rawArgs: any) => {
        const query = typeof rawArgs === 'string'
          ? rawArgs
          : (rawArgs?.query || rawArgs?.q || rawArgs?.search_query || rawArgs?.text || rawArgs?.input || '');
        const project = typeof rawArgs === 'object' ? (rawArgs?.project || rawArgs?.projectFilter) : undefined;
        const version = typeof rawArgs === 'object' ? (rawArgs?.version || rawArgs?.versionFilter) : undefined;

        if (customSearch) {
          try {
            return await customSearch(query, project, version);
          } catch (err) {
            console.warn('[docmd-assistant] Custom search failed:', err);
          }
        }
        
        // Fallback DOM Header & Content Scraper
        if (typeof document !== 'undefined') {
          const results: SearchResultItem[] = [];
          const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, section'));
          const cleanQuery = (query || '').toLowerCase().trim();

          if (!cleanQuery) return [];

          for (const el of headings) {
            const text = (el.textContent || '').trim();
            if (text.toLowerCase().includes(cleanQuery)) {
              const parent = el.closest('section, article') || el.parentElement;
              const snippet = parent ? parent.textContent?.slice(0, 200) || text : text;
              results.push({
                title: text,
                path: window.location.pathname + (el.id ? `#${el.id}` : ''),
                snippet
              });
            }
          }
          return results.slice(0, 5);
        }

        return [];
      }
    },
    {
      name: 'navigate_to_page',
      description: 'Navigate user browser to a specific URL or section anchor on the documentation site.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path or anchor hash (e.g. /docs/setup#install)' }
        },
        required: ['path']
      },
      execute: async ({ path }: { path: string }) => {
        if (typeof window !== 'undefined' && path) {
          if (path.startsWith('#')) {
            const target = document.querySelector(path);
            if (target) {
              target.scrollIntoView({ behavior: 'smooth' });
              return { success: true, navigatedTo: path };
            }
          }
          window.location.href = path;
          return { success: true, navigatedTo: path };
        }
        return { success: false, reason: 'Window object unavailable' };
      }
    },
    {
      name: 'copy_code_snippet',
      description: 'Copy a code snippet directly to the user clipboard.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'The exact code snippet to copy' }
        },
        required: ['code']
      },
      execute: async ({ code }: { code: string }) => {
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
          await navigator.clipboard.writeText(code);
          return { success: true, copiedLength: code.length };
        }
        return { success: false, reason: 'Clipboard API unavailable' };
      }
    },
    {
      name: 'read_documentation_page',
      description: 'Fetch and read the full content of a specific documentation page or section path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The page path to fetch and read (e.g. /quickstart or /docs/setup)' }
        },
        required: ['path']
      },
      execute: async ({ path: pagePath }: { path: string }) => {
        if (customReader) {
          try {
            const res = await customReader(pagePath);
            if (typeof res === 'string') {
              return { path: pagePath, content: res };
            }
            return { path: pagePath, title: res.title, content: res.content || '' };
          } catch (err) {
            console.warn('[docmd-assistant] Custom reader failed:', err);
          }
        }

        if (typeof window === 'undefined') {
          return { error: 'Window context unavailable' };
        }
        try {
          const targetUrl = pagePath.startsWith('http') ? pagePath : window.location.origin + (pagePath.startsWith('/') ? pagePath : '/' + pagePath);
          const res = await fetch(targetUrl);
          if (res.ok) {
            const html = await res.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const mainContent = doc.querySelector('main, article, [role="main"], body');
            const text = mainContent ? extractStructuredContent(mainContent) : '';
            return {
              path: pagePath,
              content: text ? (text.length > 8000 ? text.slice(0, 8000) + '\n...[content capped for token economy]' : text) : 'Page content could not be extracted.'
            };
          }
        } catch (err) {
          console.warn('[docmd-assistant] Failed to fetch page content:', err);
        }
        return { error: `Could not load page content for ${pagePath}` };
      }
    }
  ];
}