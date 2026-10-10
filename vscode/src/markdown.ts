import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });
const portableMarkdown = new MarkdownIt({ html: false, linkify: true, breaks: true });
const defaultValidateLink = markdown.validateLink.bind(markdown);
markdown.validateLink = href => /^https?:\/\//i.test(href)
  ? defaultValidateLink(href) : parseFileLinkTarget(href) !== undefined;

export interface FileLinkTarget {
  readonly path: string;
  readonly line?: number;
  readonly endLine?: number;
}

/** Parses a model-authored local file reference without interpreting command or network URIs. */
export function parseFileLinkTarget(href: string): FileLinkTarget | undefined {
  if (href.length === 0 || href.length > 4096 || /[\u0000-\u001f\u007f]/u.test(href)) return undefined;
  if (href.startsWith('#')) return undefined;
  if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) return undefined;
  if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^file:\/\//i.test(href) && !/^[a-z]:[\\/]/i.test(href)) return undefined;
  const lineMatch = href.match(/(?:(#L)([1-9]\d{0,8})(?:-L([1-9]\d{0,8}))?|(:)([1-9]\d{0,8}))$/i);
  if (lineMatch === null && /#L\d/i.test(href)) return undefined;
  const rawPath = lineMatch === null ? href : href.slice(0, -lineMatch[0].length);
  let path: string;
  try {
    if (/^file:\/\//i.test(rawPath)) {
      const url = new URL(rawPath);
      if (url.protocol !== 'file:' || (url.hostname !== '' && url.hostname !== 'localhost') || url.search || url.hash) return undefined;
      path = decodeURIComponent(url.pathname);
    } else {
      path = decodeURIComponent(rawPath);
    }
  } catch {
    return undefined;
  }
  if (path.length === 0 || /[\u0000-\u001f\u007f]/u.test(path)) return undefined;
  const line = lineMatch === null ? undefined : Number(lineMatch[2] ?? lineMatch[5]);
  const endLine = lineMatch?.[3] === undefined ? undefined : Number(lineMatch[3]);
  if (line !== undefined && endLine !== undefined && endLine < line) return undefined;
  return { path, ...(line === undefined ? {} : { line }), ...(endLine === undefined ? {} : { endLine }) };
}

function markFileLink(token: import('markdown-it').Token, target: FileLinkTarget): void {
  token.attrSet('href', '#');
  token.attrSet('class', 'dsh-file-link');
  token.attrSet('data-file-path', target.path);
  if (target.line !== undefined) token.attrSet('data-file-line', String(target.line));
  if (target.endLine !== undefined) token.attrSet('data-file-end-line', String(target.endLine));
  token.attrSet('data-vscode-context', JSON.stringify({
    webviewSection: 'dshCompanionLink', dshCompanionLinkKind: 'file',
    dshCompanionLinkTarget: target.path,
    ...(target.line === undefined ? {} : { dshCompanionLinkLine: target.line }),
    ...(target.endLine === undefined ? {} : { dshCompanionLinkEndLine: target.endLine }),
  }));
  token.attrSet('title', target.path + (target.line === undefined ? ''
    : `:${String(target.line)}${target.endLine === undefined ? '' : `-${String(target.endLine)}`}`));
}

const defaultLinkOpen = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
  const token = tokens[index];
  const href = token.attrGet('href') ?? '';
  if (/^https?:\/\//i.test(href)) {
    token.attrSet('href', '#');
    token.attrSet('class', 'dsh-external-link');
    token.attrSet('data-external-href', href);
    token.attrSet('data-vscode-context', JSON.stringify({
      webviewSection: 'dshCompanionLink', dshCompanionLinkKind: 'external', dshCompanionLinkTarget: href,
    }));
    if (token.attrGet('title') === null) token.attrSet('title', href);
  } else if (token.attrGet('data-file-path') === null) {
    const target = parseFileLinkTarget(href);
    if (target !== undefined) markFileLink(token, target);
  }
  return defaultLinkOpen === undefined
    ? renderer.renderToken(tokens, index, options)
    : defaultLinkOpen(tokens, index, options, environment, renderer);
};

const barePath = /(^|[\s(])((?:\.{1,2}\/|\/|[A-Za-z]:[\\/])?(?:[\w.-]+[\\/])+[\w.-]*[\w-]|(?:\.{1,2}\/|\/)[\w.-]*[\w-])(?:(#L|:)([1-9]\d{0,8})(?:-L([1-9]\d{0,8}))?)?(?=$|[\s),;!?.])/gu;
markdown.core.ruler.after('inline', 'local-file-paths', state => {
  for (const block of state.tokens) {
    if (block.type !== 'inline' || block.children === null) continue;
    const children: typeof block.children = [];
    let linkDepth = 0;
    for (const child of block.children) {
      if (child.type === 'link_open') linkDepth += 1;
      if (child.type === 'link_close') linkDepth -= 1;
      if (child.type !== 'text' || linkDepth > 0) {
        children.push(child);
        continue;
      }
      let offset = 0;
      barePath.lastIndex = 0;
      for (const match of child.content.matchAll(barePath)) {
        const prefix = match[1];
        const path = match[2];
        const suffix = match[3] === undefined ? '' : `${match[3]}${match[4]}${match[5] === undefined ? '' : `-L${match[5]}`}`;
        const leaf = path.split(/[\\/]/u).at(-1) ?? '';
        if (suffix === '' && !path.startsWith('/') && !path.startsWith('./') && !path.startsWith('../')
          && !/\.[A-Za-z\d][A-Za-z\d_-]{0,11}$/u.test(leaf)) continue;
        const target = parseFileLinkTarget(path + suffix);
        if (target === undefined) continue;
        const start = match.index + prefix.length;
        if (start > offset) {
          const text = new state.Token('text', '', 0);
          text.content = child.content.slice(offset, start);
          children.push(text);
        }
        const open = new state.Token('link_open', 'a', 1);
        markFileLink(open, target);
        const label = new state.Token('text', '', 0);
        label.content = path + suffix;
        const close = new state.Token('link_close', 'a', -1);
        children.push(open, label, close);
        offset = start + path.length + suffix.length;
      }
      if (offset < child.content.length) {
        const text = new state.Token('text', '', 0);
        text.content = child.content.slice(offset);
        children.push(text);
      }
    }
    block.children = children;
  }
});

function closedMermaidFence(token: import('markdown-it').Token, source: string): boolean {
  if (token.info.trim().split(/\s+/u)[0]?.toLowerCase() !== 'mermaid' || token.map === null) return false;
  const lines = source.split(/\r?\n/u);
  const closing = lines[token.map[1] - 1] ?? '';
  const marker = token.markup[0] === '~' ? '~' : '`';
  const match = closing.match(/^ {0,3}(`+|~+)\s*$/u);
  return match !== null && match[1][0] === marker && match[1].length >= token.markup.length;
}

for (const kind of ['fence', 'code_block'] as const) {
  const original = markdown.renderer.rules[kind];
  markdown.renderer.rules[kind] = (tokens, index, options, environment, renderer) => {
    const rendered = original === undefined
      ? renderer.renderToken(tokens, index, options)
      : original(tokens, index, options, environment, renderer);
    const mermaid = kind === 'fence' && closedMermaidFence(tokens[index], environment.source ?? '');
    return `<div class="code-block${mermaid ? ' mermaid-block' : ''}"><button type="button" class="copy-code" aria-label="Copy code">Copy</button>${rendered}</div>`;
  };
}

/** Renders model-authored Markdown with raw HTML disabled and local file references marked for VS Code. */
export function renderMarkdown(source: string): string {
  return markdown.render(source, { source });
}

/** Renders clipboard-ready HTML without Webview controls or VS Code link metadata. */
export function renderPortableMarkdown(source: string): string {
  return portableMarkdown.render(source);
}
