const MarkdownIt = require('markdown-it');
const purifier = require('dompurify');
const highlight = require('highlight.js');
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false, highlight: (text, language) => {
  if (language && highlight.getLanguage(language)) {
    try { return highlight.highlight(text, { language, ignoreIllegals: true }).value; } catch {}
  }
  return '';
} });
// Agent output is untrusted, particularly in this Node-enabled Electron renderer.
function renderMarkdown(text) {
  return purifier.sanitize(markdown.render(text || ''), { ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 's', 'a', 'code', 'pre', 'span', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'], ALLOWED_ATTR: ['href', 'title', 'class', 'start', 'align'], ALLOW_DATA_ATTR: false });
}
module.exports = { renderMarkdown };
