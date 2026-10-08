const { Plugin, Notice, TFile, normalizePath } = require('obsidian');

module.exports = class InlineCanvas extends Plugin {
  onload() {
    this.busy = false;
    this.previews = new Map();
    this.observers = new Map();
    this.previewCounter = 0;
    this.previewDisposed = false;
    this.register(() => {
      this.previewDisposed = true;
      clearTimeout(this.scanTimer);
      clearTimeout(this.refreshTimer);
      for (const observer of this.observers.values()) observer.disconnect();
      for (const preview of this.previews.values()) this.removePreview(preview);
      this.previews.clear();
    });
    this.addCommand({
      id: 'insert-canvas', name: '插入流程图白板',
      editorCallback: (editor, info) => this.insertCanvas(editor, info)
    });
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, info) => {
      if (!info.file || info.file.extension !== 'md') return;
      menu.addItem(item => item.setTitle('插入流程图白板').setIcon('layout-dashboard')
        .onClick(() => this.insertCanvas(editor, info)));
    }));
    this.registerMarkdownPostProcessor((element, context) => this.scanPreviewRoot(element, context.sourcePath));
    this.registerEvent(this.app.vault.on('modify', () => this.queuePreviewRefresh()));
    this.registerEvent(this.app.vault.on('rename', () => this.queuePreviewRefresh()));
    this.registerEvent(this.app.vault.on('delete', () => this.queuePreviewRefresh()));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.startPreviewObservers()));
    this.registerEvent(this.app.workspace.on('window-open', () => this.startPreviewObservers()));
    this.app.workspace.onLayoutReady(() => this.startPreviewObservers());
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && file.extension === 'canvas') {
        menu.addItem(item => item.setTitle('在旁边编辑流程图').setIcon('pencil')
          .onClick(() => this.openCanvas(file).catch(error => this.report(error))));
      }
    }));
  }

  startPreviewObservers() {
    if (this.previewDisposed) return;
    const documents = new Set([this.app.workspace.containerEl.ownerDocument]);
    this.app.workspace.iterateAllLeaves(leaf => documents.add(leaf.containerEl.ownerDocument));
    for (const doc of documents) this.observePreviewDocument(doc);
  }

  observePreviewDocument(doc) {
    if (!doc || !doc.body || this.observers.has(doc)) return;
    const observer = new doc.defaultView.MutationObserver(records => {
      // Ignore our SVG updates; observe host embeds and Slides as they appear.
      if (records.some(record => !record.target.closest?.('.inline-canvas-preview') &&
          [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && !node.classList?.contains('inline-canvas-preview')) || record.type === 'attributes')) {
        clearTimeout(this.scanTimer);
        this.scanTimer = setTimeout(() => {
          for (const document of this.observers.keys()) this.scanPreviewRoot(document.body);
          for (const [embed, preview] of this.previews) {
            if (!embed.isConnected) { this.removePreview(preview); this.previews.delete(embed); }
          }
        }, 80);
      }
    });
    observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    this.observers.set(doc, observer);
    this.registerDomEvent(doc, 'load', event => {
      if (event.target?.tagName === 'IFRAME') this.observePreviewFrame(event.target);
    }, true);
    this.scanPreviewRoot(doc.body);
  }

  observePreviewFrame(frame) {
    // Only the local Slides document; never inspect arbitrary embedded web pages.
    if (!frame.closest('.workspace-leaf-content[data-type="slides"]')) return;
    try { this.observePreviewDocument(frame.contentDocument); } catch (_) { /* Cross-origin frame. */ }
  }

  scanPreviewRoot(root, sourcePath) {
    if (!root || this.previewDisposed) return;
    const embeds = [...root.querySelectorAll('.internal-embed[src]')];
    if (root.matches?.('.internal-embed[src]')) embeds.unshift(root);
    for (const embed of embeds) {
      const src = embed.getAttribute('src') || '';
      const path = src.split('#')[0];
      const previous = this.previews.get(embed);
      if (!path.toLowerCase().endsWith('.canvas')) {
        if (previous) { this.removePreview(previous); this.previews.delete(embed); }
        continue;
      }
      if (previous?.src === src && previous.root.parentNode === embed) {
        if (sourcePath && previous.sourcePath !== sourcePath) {
          previous.sourcePath = sourcePath;
          this.updatePreview(previous);
        }
        continue;
      }
      if (previous) this.removePreview(previous);
      let origin = sourcePath;
      if (!origin) this.app.workspace.iterateAllLeaves(leaf => {
        if (leaf.containerEl.contains(embed) || leaf.containerEl.contains(embed.ownerDocument.defaultView?.frameElement)) origin = leaf.view.file?.path;
      });
      this.mountPreview(embed, src, origin || '');
    }
    root.querySelectorAll('iframe').forEach(frame => this.observePreviewFrame(frame));
  }

  mountPreview(embed, src, sourcePath) {
    const doc = embed.ownerDocument;
    const root = doc.createElement('div');
    root.className = 'inline-canvas-preview';
    // Carry styles with the preview so the same renderer works in Slides documents.
    const style = doc.createElement('style');
    style.textContent = '.inline-canvas-full-preview > :not(.inline-canvas-preview){display:none!important}.inline-canvas-preview{display:block;width:100%;text-align:left}.inline-canvas-preview svg{display:block;width:100%;height:auto;max-height:480px}.inline-canvas-preview-toolbar{display:flex;gap:8px;align-items:center;margin:8px 0;font-size:13px}.inline-canvas-preview-error{color:var(--text-error,#b42318)}';
    root.appendChild(style);
    const picture = doc.createElement('div');
    root.appendChild(picture);
    const toolbar = doc.createElement('div');
    toolbar.className = 'inline-canvas-preview-toolbar';
    const edit = doc.createElement('button');
    edit.className = 'inline-canvas-edit'; edit.textContent = '编辑流程图';
    const status = doc.createElement('span');
    toolbar.append(edit, status); root.appendChild(toolbar);
    const preview = { embed, root, picture, status, src, sourcePath, generation: 0, id: 'ic' + ++this.previewCounter };
    edit.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      const file = this.resolvePreviewFile(preview);
      if (file) this.openCanvas(file).catch(error => this.report(error));
      else new Notice('找不到白板文件，请检查链接。');
    });
    root.addEventListener('click', event => event.stopPropagation());
    embed.appendChild(root);
    this.previews.set(embed, preview);
    this.updatePreview(preview);
  }

  resolvePreviewFile(preview) {
    const path = preview.src.split('#')[0];
    const file = this.app.vault.getAbstractFileByPath(path) || this.app.metadataCache.getFirstLinkpathDest(path, preview.sourcePath);
    return file instanceof TFile && file.extension === 'canvas' ? file : null;
  }

  queuePreviewRefresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      for (const preview of this.previews.values()) if (preview.embed.isConnected) this.updatePreview(preview);
    }, 180);
  }

  async updatePreview(preview) {
    const generation = ++preview.generation;
    try {
      const file = this.resolvePreviewFile(preview);
      if (!file) throw new Error('找不到白板文件');
      const data = JSON.parse(await this.app.vault.cachedRead(file));
      const texts = new Map();
      await Promise.all((data.nodes || []).filter(node => node.type === 'file').map(async node => {
        const target = this.app.vault.getAbstractFileByPath(node.file) || this.app.metadataCache.getFirstLinkpathDest(node.file, file.path);
        if (target instanceof TFile && target.extension === 'md') {
          let text = await this.app.vault.cachedRead(target);
          // Respect note-card heading/block references when metadata is available.
          if (node.subpath) {
            const cache = this.app.metadataCache.getFileCache(target);
            if (node.subpath.startsWith('#^')) {
              const block = cache?.blocks?.[node.subpath.slice(2)];
              text = block ? text.slice(block.position.start.offset, block.position.end.offset) : node.file + node.subpath;
            } else {
              const headings = cache?.headings || [];
              const index = headings.findIndex(h => h.heading === node.subpath.slice(1));
              const heading = headings[index];
              const next = headings.slice(index + 1).find(h => h.level <= heading?.level);
              text = heading ? text.slice(heading.position.start.offset, next?.position.start.offset) : node.file + node.subpath;
            }
          }
          texts.set(node.id, text);
        }
      }));
      const svg = renderCanvasSvg(data, texts, preview.id, preview.src.split('#')[1]);
      if (generation !== preview.generation || !this.previews.has(preview.embed)) return;
      const parser = new preview.embed.ownerDocument.defaultView.DOMParser();
      const parsed = parser.parseFromString(svg, 'image/svg+xml');
      if (parsed.querySelector('parsererror')) throw new Error('白板预览无法生成');
      preview.picture.replaceChildren(preview.embed.ownerDocument.importNode(parsed.documentElement, true));
      preview.embed.classList.add('inline-canvas-full-preview');
      preview.status.textContent = ''; preview.status.className = '';
    } catch (error) {
      if (generation !== preview.generation || !this.previews.has(preview.embed)) return;
      preview.status.textContent = '预览失败：' + error.message;
      preview.status.className = 'inline-canvas-preview-error';
      // Restore native preview rather than silently showing an outdated drawing.
      preview.picture.replaceChildren();
      preview.embed.classList.remove('inline-canvas-full-preview');
    }
  }

  removePreview(preview) {
    ++preview.generation;
    preview.root.remove();
    preview.embed.classList.remove('inline-canvas-full-preview');
  }

  report(error) {
    console.error('Inline Canvas:', error);
    new Notice('白板操作失败：' + (error.message || String(error)));
  }

  async openCanvas(file) {
    await this.app.workspace.getLeaf('split', 'vertical').openFile(file);
  }

  async insertCanvas(editor, info) {
    if (this.busy || !info.file) return;
    this.busy = true;
    const note = info.file;
    const position = editor.getCursor();
    const original = editor.getValue();
    let file;
    try {
      const folder = normalizePath((note.parent && note.parent.path !== '/' ? note.parent.path + '/' : '') + 'Flowcharts');
      if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
      const stamp = Date.now().toString(36);
      let path = normalizePath(folder + '/' + note.basename + '-流程图-' + stamp + '.canvas');
      let suffix = 1;
      while (this.app.vault.getAbstractFileByPath(path)) {
        path = normalizePath(folder + '/' + note.basename + '-流程图-' + stamp + '-' + suffix++ + '.canvas');
      }
      const canvas = {
        nodes: [{ id: 'start', type: 'text', text: '请在此输入内容', x: 0, y: 0, width: 220, height: 100 }],
        edges: []
      };
      file = await this.app.vault.create(path, JSON.stringify(canvas, null, 2));
      // Do not insert into an editor that changed while the file was being created.
      if (editor.getValue() !== original || !info.file || info.file.path !== note.path) {
        new Notice('笔记已变化，白板已保存在：' + path + '。请重新插入链接。');
        return;
      }
      const link = this.app.fileManager.generateMarkdownLink(file, note.path);
      const prefix = position.ch > 0 ? '\n\n' : '';
      editor.replaceRange(prefix + '!' + link + '\n\n', position);
      await this.openCanvas(file);
      new Notice('白板已插入笔记，在右侧编辑即可自动保存。');
    } catch (error) {
      this.report(error);
      if (file) new Notice('白板文件已保留：' + file.path);
    } finally {
      this.busy = false;
    }
  }
};

// Standalone SVG uses text elements, not foreignObject: it also works in Slides.
function renderCanvasSvg(data, texts = new Map(), prefix = 'ic', focusId) {
  if (!data || !Array.isArray(data.nodes)) throw new Error('白板数据缺少 nodes 数组');
  const escape = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
  prefix = String(prefix).replace(/[^a-zA-Z0-9_-]/g, '') || 'ic';
  let nodes = data.nodes.filter(n => n && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(n[key])) && n.width > 0 && n.height > 0);
  if (focusId) {
    const focus = nodes.find(n => n.id === focusId);
    if (!focus) throw new Error('找不到指定的白板卡片');
    nodes = focus.type === 'group' ? nodes.filter(n => n === focus || n.x >= focus.x && n.y >= focus.y && n.x + n.width <= focus.x + focus.width && n.y + n.height <= focus.y + focus.height) : [focus];
  }
  if (!nodes.length) return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 100" role="img" aria-label="空白流程图"><rect width="320" height="100" fill="#f8fafc"/><text x="20" y="55" font-size="16" fill="#334155">空白流程图</text></svg>';
  const palette = { '1': '#dc2626', '2': '#ea580c', '3': '#ca8a04', '4': '#16a34a', '5': '#0891b2', '6': '#9333ea' };
  const color = value => palette[value] || (/^#[0-9a-fA-F]{6}$/.test(value || '') ? value : '#64748b');
  const minX = Math.min(...nodes.map(n => n.x)) - 60;
  const minY = Math.min(...nodes.map(n => n.y)) - 60;
  const width = Math.max(...nodes.map(n => n.x + n.width)) - minX + 60;
  const height = Math.max(...nodes.map(n => n.y + n.height)) - minY + 60;
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const wrap = (text, available) => {
    const lines = [];
    for (const paragraph of String(text ?? '').replace(/\r/g, '').split('\n')) {
      let line = '', units = 0;
      for (const character of paragraph) {
        const size = character.codePointAt(0) > 255 ? 16 : 8.5;
        if (line && units + size > available) { lines.push(line); line = ''; units = 0; }
        line += character; units += size;
      }
      lines.push(line);
    }
    return lines;
  };
  const textMarkup = (text, x, y, available, rows, clip = '') => {
    const lines = wrap(text, Math.max(16, available));
    const visible = lines.slice(0, rows);
    if (lines.length > rows && visible.length) visible[visible.length - 1] = visible[visible.length - 1].slice(0, -1) + '…';
    return `<text x="${x}" y="${y}" fill="#1e293b" font-size="16" font-family="system-ui, sans-serif"${clip ? ` clip-path="url(#${clip})"` : ''}>${visible.map((line, i) => `<tspan x="${x}" dy="${i ? 22 : 0}">${escape(line)}</tspan>`).join('')}</text>`;
  };
  const anchor = (n, side) => ({
    top: [n.x + n.width / 2, n.y, 0, -1], bottom: [n.x + n.width / 2, n.y + n.height, 0, 1],
    left: [n.x, n.y + n.height / 2, -1, 0], right: [n.x + n.width, n.y + n.height / 2, 1, 0]
  }[side] || [n.x + n.width / 2, n.y + n.height, 0, 1]);
  const defs = [], groups = [], cards = [], edges = [], labels = [];
  nodes.forEach((n, i) => {
    const stroke = color(n.color), clip = prefix + '-clip-' + i;
    const label = n.type === 'text' ? n.text : n.type === 'group' ? n.label : n.type === 'file' ? (texts.get(n.id) ?? '附件：' + (n.file || '')) : n.url || '';
    if (n.type === 'group') {
      groups.push(`<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="8" fill="${n.color ? stroke : '#f1f5f9'}" fill-opacity="0.12" stroke="${stroke}" stroke-width="2"/>` + textMarkup(label, n.x + 12, n.y - 12, n.width - 24, 1));
    } else {
      defs.push(`<clipPath id="${clip}"><rect x="${n.x + 10}" y="${n.y + 10}" width="${Math.max(1, n.width - 20)}" height="${Math.max(1, n.height - 20)}"/></clipPath>`);
      cards.push(`<g><title>${escape(label)}</title><rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="8" fill="#ffffff" stroke="${stroke}" stroke-width="2"/>` + textMarkup(label, n.x + 14, n.y + 30, n.width - 28, Math.max(1, Math.floor((n.height - 20) / 22)), clip) + '</g>');
    }
  });
  for (const [index, edge] of (Array.isArray(data.edges) ? data.edges : []).entries()) {
    if (!edge) continue;
    const from = nodeMap.get(edge.fromNode), to = nodeMap.get(edge.toNode);
    if (!from || !to) continue;
    const a = anchor(from, edge.fromSide || 'bottom'), b = anchor(to, edge.toSide || 'top');
    const distance = Math.max(40, Math.min(160, Math.hypot(b[0] - a[0], b[1] - a[1]) / 2));
    const p = [a[0] + a[2] * distance, a[1] + a[3] * distance];
    const q = [b[0] + b[2] * distance, b[1] + b[3] * distance];
    const stroke = color(edge.color), marker = prefix + '-arrow-' + index;
    defs.push(`<marker id="${marker}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${stroke}"/></marker>`);
    edges.push(`<path d="M ${a[0]} ${a[1]} C ${p[0]} ${p[1]}, ${q[0]} ${q[1]}, ${b[0]} ${b[1]}" fill="none" stroke="${stroke}" stroke-width="2"${edge.fromEnd === 'arrow' ? ` marker-start="url(#${marker})"` : ''}${edge.toEnd !== 'none' ? ` marker-end="url(#${marker})"` : ''}/>`);
    if (edge.label) {
      const x = (a[0] + 3 * p[0] + 3 * q[0] + b[0]) / 8;
      const y = (a[1] + 3 * p[1] + 3 * q[1] + b[1]) / 8;
      const lines = wrap(edge.label, 200), w = Math.min(224, Math.max(...lines.map(l => [...l].reduce((s, c) => s + (c.codePointAt(0) > 255 ? 16 : 8.5), 0))) + 24);
      const h = Math.min(3, lines.length) * 22 + 10;
      labels.push(`<rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="4" fill="#f8fafc"/>` + textMarkup(edge.label, x - w / 2 + 12, y - h / 2 + 22, w - 24, 3));
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${width} ${height}" role="img" aria-label="包含卡片文字的流程图"><rect x="${minX}" y="${minY}" width="${width}" height="${height}" rx="8" fill="#f8fafc"/><defs>${defs.join('')}</defs>${groups.join('')}${edges.join('')}${cards.join('')}${labels.join('')}</svg>`;
}

module.exports.renderCanvasSvg = renderCanvasSvg;
