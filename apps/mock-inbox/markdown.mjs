// A small Markdown-to-email-HTML renderer for agent answers. Input is
// untrusted: everything is escaped first, only https links survive, and
// styles are inline because mail clients drop most stylesheets.

const STYLE = {
  p: 'margin:0 0 12px',
  h: 'font-size:16px;line-height:1.4;margin:18px 0 8px;font-weight:700',
  list: 'margin:0 0 12px;padding-left:22px',
  li: 'margin:0 0 4px',
  pre: 'background:#f4f4f2;border-radius:6px;padding:10px 12px;margin:0 0 12px;overflow-x:auto;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word',
  code: 'background:#f4f4f2;border-radius:4px;padding:1px 4px;font:0.9em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
  quote: 'margin:0 0 12px;padding:0 0 0 12px;border-left:3px solid #d8dcd6;color:#4b5550',
  table: 'border-collapse:collapse;margin:0 0 12px;font-size:14px',
  cell: 'border:1px solid #dfe3dd;padding:5px 9px;text-align:left;vertical-align:top',
  hr: 'border:0;border-top:1px solid #e3e6e1;margin:16px 0',
  a: 'color:#1f5c41;text-decoration:underline',
};

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function inline(source) {
  const codes = [];
  let text = source.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(`<code style="${STYLE.code}">${escapeHtml(code)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  const links = [];
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, href) => {
    const url = httpsUrl(href);
    // Local file links (common in agent answers) keep their label as plain text.
    links.push(url ? `<a href="${escapeHtml(url)}" style="${STYLE.a}">${escapeHtml(label)}</a>` : escapeHtml(label));
    return `\u0001${links.length - 1}\u0001`;
  });
  text = text.replace(/(^|[\s(])(https:\/\/[^\s<>()\u0000\u0001]+[^\s<>().,;:!?'"\u0000\u0001])/g, (match, lead, href) => {
    const url = httpsUrl(href);
    if (!url) return match;
    links.push(`<a href="${escapeHtml(url)}" style="${STYLE.a}">${escapeHtml(href)}</a>`);
    return `${lead}\u0001${links.length - 1}\u0001`;
  });
  text = escapeHtml(text)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\s][^_\n]*?)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  return text
    .replace(/\u0001(\d+)\u0001/g, (_, index) => links[Number(index)])
    .replace(/\u0000(\d+)\u0000/g, (_, index) => codes[Number(index)]);
}

const LIST_ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

export function renderMarkdown(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      const body = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(fence[1])) body.push(lines[index++]);
      index += 1;
      html.push(`<pre style="${STYLE.pre}">${escapeHtml(body.join('\n'))}</pre>`);
      continue;
    }
    const heading = line.match(/^\s*#{1,6}\s+(.*?)\s*#*\s*$/);
    if (heading) {
      html.push(`<p style="${STYLE.h}">${inline(heading[1])}</p>`);
      index += 1;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      html.push(`<hr style="${STYLE.hr}">`);
      index += 1;
      continue;
    }
    if (line.includes('|') && index + 1 < lines.length && TABLE_RULE.test(lines[index + 1])) {
      const head = cells(line);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(cells(lines[index++]));
      html.push(`<table style="${STYLE.table}"><thead><tr>${head.map((cell) =>
        `<th style="${STYLE.cell}">${inline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) =>
        `<tr>${head.map((_, column) => `<td style="${STYLE.cell}">${inline(row[column] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quoted = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) quoted.push(lines[index++].replace(/^\s*>\s?/, ''));
      html.push(`<blockquote style="${STYLE.quote}">${renderMarkdown(quoted.join('\n'))}</blockquote>`);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      // Collect the list, then nest items by indentation.
      const items = [];
      while (index < lines.length) {
        const match = lines[index].match(LIST_ITEM);
        if (match) {
          items.push({ depth: Math.floor(match[1].replace(/\t/g, '  ').length / 2), ordered: /\d/.test(match[2]), text: match[3] });
        } else if (lines[index].trim() && /^\s+/.test(lines[index]) && items.length) {
          items.at(-1).text += ` ${lines[index].trim()}`;
        } else break;
        index += 1;
      }
      html.push(renderList(items, 0, 0).html);
      continue;
    }
    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !LIST_ITEM.test(lines[index]) &&
      !/^\s*(```|~~~|#{1,6}\s|>)/.test(lines[index])) paragraph.push(lines[index++].trim());
    html.push(`<p style="${STYLE.p}">${paragraph.map(inline).join('<br>')}</p>`);
  }
  return html.join('');
}

function renderList(items, start, depth) {
  const tag = items[start].ordered ? 'ol' : 'ul';
  let html = `<${tag} style="${STYLE.list}">`;
  let index = start;
  while (index < items.length && items[index].depth >= depth) {
    const item = items[index];
    if (item.depth > depth) {
      const nested = renderList(items, index, item.depth);
      html = html.replace(/<\/li>$/, `${nested.html}</li>`);
      index = nested.next;
      continue;
    }
    html += `<li style="${STYLE.li}">${inline(item.text)}</li>`;
    index += 1;
  }
  return { html: `${html}</${tag}>`, next: index };
}
