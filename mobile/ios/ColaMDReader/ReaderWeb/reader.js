(() => {
  const root = document.getElementById('document');

  marked.use({
    gfm: true,
    breaks: true,
    pedantic: false
  });

  function sanitize(html) {
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ['checked', 'disabled', 'start'],
      FORBID_TAGS: ['base', 'embed', 'form', 'iframe', 'link', 'meta', 'object', 'script', 'style', 'svg'],
      FORBID_ATTR: ['formaction', 'srcset', 'style']
    });
  }

  function decorateDocument() {
    root.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.disabled = true;
      input.setAttribute('aria-readonly', 'true');
    });

    root.querySelectorAll('table').forEach((table) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'table-wrap';
      table.parentNode.insertBefore(wrapper, table);
      wrapper.appendChild(table);
    });

    root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((heading, index) => {
      heading.id = `heading-${index}`;
    });
  }

  function render(payload) {
    const markdown = typeof payload.markdown === 'string' ? payload.markdown : '';
    const supportedThemes = new Set([
      'light', 'dark', 'elegant', 'sepia', 'notion', 'bear', 'writer',
      'solarized-dark', 'nord', 'gruvbox', 'dracula', 'midnight'
    ]);
    const theme = supportedThemes.has(payload.theme) ? payload.theme : 'light';
    const fontSize = Number.isFinite(payload.fontSize) ? Math.min(Math.max(payload.fontSize, 14), 28) : 18;

    document.documentElement.dataset.theme = theme;
    document.documentElement.style.setProperty('--font-size', `${fontSize}px`);

    try {
      const html = marked.parse(markdown);
      root.innerHTML = sanitize(html);
      decorateDocument();
      if (!root.textContent.trim() && !root.querySelector('img, input')) {
        root.innerHTML = '<p class="markdown-empty">这份 Markdown 文档没有可阅读内容。</p>';
      }
    } catch {
      root.innerHTML = '<p class="markdown-empty">文档无法渲染。</p>';
    }
  }

  function scrollToHeading(identifier) {
    const heading = document.getElementById(identifier);
    if (heading) {
      heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  window.ColaMDReader = { render, scrollToHeading };
})();
