import { AssistantTool, SearchResultItem } from '../types.js';

export function createStandardTools(customSearch?: (query: string) => Promise<SearchResultItem[]>): AssistantTool[] {
  return [
    {
      name: 'search_documentation',
      description: 'Search documentation content for answers to specific user questions.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query string' }
        },
        required: ['query']
      },
      execute: async ({ query }: { query: string }) => {
        if (customSearch) {
          try {
            return await customSearch(query);
          } catch (err) {
            console.warn('[docmd-assistant] Custom search failed:', err);
          }
        }
        
        // Fallback DOM Header & Content Scraper
        if (typeof document !== 'undefined') {
          const results: SearchResultItem[] = [];
          const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, section'));
          const cleanQuery = query.toLowerCase();

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
            const text = mainContent ? (mainContent.textContent || '').replace(/\s+/g, ' ').slice(0, 3500) : '';
            return {
              path: pagePath,
              content: text || 'Page content could not be extracted.'
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