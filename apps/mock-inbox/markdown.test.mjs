import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown } from './markdown.mjs';

// The outbox renders every agent answer; a throw here would retry the same
// reply forever and hold up every account's mail behind it.
test('an answer of thousands of nested quotes renders a bounded depth instead of overflowing the stack', () => {
  for (const styled of [true, false]) {
    const html = renderMarkdown(`${'>'.repeat(6000)} deep`, { styled });
    assert.equal(html.match(/<blockquote/g).length, 8);
    assert.match(html, /&gt;&gt;&gt;.* deep/);
  }
  assert.equal(renderMarkdown('> a\n>> b\nplain', { styled: false }),
    '<blockquote><p>a</p><blockquote><p>b</p></blockquote></blockquote><p>plain</p>');
});
