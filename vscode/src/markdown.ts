import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });

/** Renders model-authored Markdown with raw HTML disabled. */
export function renderMarkdown(source: string): string {
  return markdown.render(source);
}
