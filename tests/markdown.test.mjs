import assert from 'node:assert/strict';
import test from 'node:test';

import { renderMarkdown } from '../vscode/out/markdown.js';

test('assistant Markdown renders common document structures', () => {
  const html = renderMarkdown('# Heading\n\n- one\n- two\n\n```ts\nconst value = 1;\n```');
  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<pre><code class="language-ts">/);
});

test('assistant Markdown escapes raw HTML and unsafe links', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n[bad](javascript:alert(1))');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /href="javascript:/);
});
