import assert from 'node:assert/strict';
import test from 'node:test';

import { parseFileLinkTarget, renderMarkdown, renderPortableMarkdown } from '../vscode/out/markdown.js';

test('assistant Markdown renders common document structures', () => {
  const html = renderMarkdown('# Heading\n\n- one\n- two\n\n```ts\nconst value = 1;\n```');
  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<pre><code class="language-ts">/);
  assert.match(html, /class="code-block"><button type="button" class="copy-code"/);
});

test('only closed Mermaid fences become diagram candidates during streaming', () => {
  assert.doesNotMatch(renderMarkdown('```mermaid\ngraph TD\nA-->B'), /mermaid-block/u);
  assert.match(renderMarkdown('```mermaid\ngraph TD\nA-->B\n```'), /class="code-block mermaid-block"/u);
  assert.doesNotMatch(renderMarkdown('```ts\ngraph TD\nA-->B\n```'), /mermaid-block/u);
});

test('portable HTML omits Webview copy controls and file-action metadata', () => {
  const html = renderPortableMarkdown('[source](src/app.ts:2)\n\n```ts\nconst value = 1;\n```\n<script>bad</script>');
  assert.doesNotMatch(html, /copy-code|data-file-path|<script>/);
  assert.match(html, /<a href="src\/app\.ts:2">source<\/a>/);
  assert.match(html, /<pre><code class="language-ts">/);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
});

test('assistant Markdown escapes raw HTML and unsafe links', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n[bad](javascript:alert(1))');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /href="javascript:/);
});

test('local Markdown links retain paths and line numbers for VS Code', () => {
  const html = renderMarkdown('[source](src/app.ts:42) [root](/etc/hosts#L3) [url](file:///tmp/a%20b.ts:7)');
  assert.match(html, /data-file-path="src\/app\.ts" data-file-line="42"/);
  assert.match(html, /data-file-path="\/etc\/hosts" data-file-line="3"/);
  assert.match(html, /data-file-path="\/tmp\/a b\.ts" data-file-line="7"/);
  assert.match(html, /data-vscode-context="\{&quot;webviewSection&quot;:&quot;dshCompanionLink&quot;,&quot;dshCompanionLinkKind&quot;:&quot;file&quot;/);
  assert.equal((html.match(/class="dsh-file-link"/g) ?? []).length, 3);
});

test('GitHub line ranges are removed from file paths and shown in the hover tooltip', () => {
  const reference = 'target/linux/ramips/mt76x8/base-files/etc/board.d/01_leds#L117-L122';
  const target = parseFileLinkTarget(reference);
  assert.deepEqual(target, {
    path: 'target/linux/ramips/mt76x8/base-files/etc/board.d/01_leds', line: 117, endLine: 122,
  });
  const html = renderMarkdown(`[LEDs](${reference}) and ${reference}`);
  assert.equal((html.match(/data-file-path="target\/linux\/ramips\/mt76x8\/base-files\/etc\/board\.d\/01_leds"/g) ?? []).length, 2);
  assert.equal((html.match(/data-file-line="117" data-file-end-line="122"/g) ?? []).length, 2);
  assert.equal((html.match(/title="target\/linux\/ramips\/mt76x8\/base-files\/etc\/board\.d\/01_leds:117-122"/g) ?? []).length, 2);
  assert.equal(parseFileLinkTarget('src/a.ts#L122-L117'), undefined);
});

test('bare paths are linked outside code and explicit links without double-linking', () => {
  const html = renderMarkdown('See src/app.ts:42, ./Makefile and /etc/hosts. `src/code.ts:1` [file](src/a.ts:2)');
  assert.match(html, /data-file-path="src\/app\.ts" data-file-line="42"/);
  assert.match(html, /data-file-path="\.\/Makefile"/);
  assert.match(html, /data-file-path="\/etc\/hosts"[^>]*title="\/etc\/hosts">\/etc\/hosts<\/a>\./);
  assert.match(html, /<code>src\/code\.ts:1<\/code>/);
  assert.equal((html.match(/class="dsh-file-link"/g) ?? []).length, 4);
});

test('unsafe protocols stay non-actionable and external HTTP links stay external', () => {
  const html = renderMarkdown('[command](command:workbench.action.files.openFile) [web](https://example.com/a/b) [bad](javascript:alert(1)) [remote](file://other-host/tmp/a)');
  assert.doesNotMatch(html, /data-file-path="command/);
  assert.doesNotMatch(html, /href="command:/);
  assert.doesNotMatch(html, /href="file:\/\/other-host/);
  assert.match(html, /href="#" class="dsh-external-link" data-external-href="https:\/\/example\.com\/a\/b"/);
  assert.match(html, /dshCompanionLinkKind&quot;:&quot;external&quot;/);
  assert.doesNotMatch(html, /<a href="https:\/\//);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.equal(parseFileLinkTarget('vscode://anything'), undefined);
  assert.equal(parseFileLinkTarget('#section'), undefined);
});

test('autolinked web addresses use only the Companion external-open path', () => {
  const html = renderMarkdown('See https://example.com/docs');
  assert.match(html, /href="#" class="dsh-external-link" data-external-href="https:\/\/example\.com\/docs"/);
  assert.doesNotMatch(html, /<a href="https:\/\//);
  assert.match(renderMarkdown('[docs](https://example.com "Project docs")'), /title="Project docs"/);
});
