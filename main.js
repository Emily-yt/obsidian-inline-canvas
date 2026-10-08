const { Plugin, Notice, TFile, normalizePath, setIcon } = require('obsidian');

module.exports = class InlineCanvas extends Plugin {
  onload() {
    this.busy = false;
    this.previews = new Map();
    this.observers = new Map();
    this.autoFitWrites = new Set();
    this.autoFitTimers = new Map();
    this.activePointers = new Set();

    this.previewDisposed = false;
    this.register(() => {
      this.previewDisposed = true;
      clearTimeout(this.scanTimer);
      clearTimeout(this.refreshTimer);
      for (const timer of this.autoFitTimers.values()) clearTimeout(timer);
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
    this.registerEvent(this.app.vault.on('modify', file => {
      this.queuePreviewRefresh();
      if (file.extension === 'canvas') this.queueOpenCanvasFit(file);
    }));
    this.registerEvent(this.app.vault.on('rename', () => this.queuePreviewRefresh()));
    this.registerEvent(this.app.vault.on('delete', () => this.queuePreviewRefresh()));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.startPreviewObservers()));
    this.registerEvent(this.app.workspace.on('window-open', () => this.startPreviewObservers()));
    this.app.workspace.onLayoutReady(() => this.startPreviewObservers());
    this.addCommand({
      id: 'fit-text-cards', name: '根据内容调整文字卡片大小',
      checkCallback: checking => {
        const file = this.app.workspace.getActiveFile();
        if (file?.extension !== 'canvas') return false;
        if (!checking) this.queueOpenCanvasFit(file);
        return true;
      }
    });
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
    this.registerDomEvent(doc, 'pointerdown', event => this.activePointers.add(event.pointerId), true);
    const release = event => this.activePointers.delete(event.pointerId);
    this.registerDomEvent(doc, 'pointerup', release, true);
    this.registerDomEvent(doc, 'pointercancel', release, true);
    this.registerDomEvent(doc.defaultView, 'blur', () => this.activePointers.clear());
    this.registerDomEvent(doc, 'focusout', () => {
      const file = this.app.workspace.getActiveFile();
      if (file?.extension === 'canvas') this.queueOpenCanvasFit(file);
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
      if (embed.closest('.inline-canvas-preview')) continue;
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
    style.textContent = '.inline-canvas-full-preview > :not(.inline-canvas-preview){display:none!important}.inline-canvas-preview{display:block;width:100%;text-align:left}.inline-canvas-native{height:200px;max-width:100%;position:relative;overflow:hidden;border-radius:var(--radius-m);border:1px solid var(--background-modifier-border);background:var(--background-primary);font-size:var(--font-text-size,16px);font-family:var(--font-text);line-height:var(--line-height-normal);color:var(--text-normal)}.inline-canvas-native > .workspace-leaf-content{height:100%;width:100%;position:relative;display:flex;flex-direction:column}.inline-canvas-native .view-content{height:100%;width:100%;padding:0;overflow:hidden;flex:1}.inline-canvas-native .view-header,.inline-canvas-native .canvas-card-menu,.inline-canvas-native .canvas-controls,.inline-canvas-native .canvas-menu-container,.inline-canvas-native .canvas-menu{display:none!important}.inline-canvas-native .canvas-wrapper{height:100%;width:100%;font-size:var(--font-text-size,16px);text-align:left}.inline-canvas-preview-toolbar{display:flex;justify-content:flex-end;gap:4px;align-items:center;max-width:100%;margin:6px 0;font-size:13px}.inline-canvas-preview-toolbar button{display:flex;align-items:center;justify-content:center;width:28px;height:28px;padding:4px;margin:0;background:transparent;box-shadow:none;border:0;color:var(--text-muted);cursor:pointer}.inline-canvas-preview-toolbar button:hover{background:var(--background-modifier-hover);color:var(--text-normal)}.inline-canvas-preview-toolbar button svg{width:18px;height:18px}.inline-canvas-preview-error{color:var(--text-error,#b42318)}.slides-container .inline-canvas-native h1{font-size:var(--h1-size)}.slides-container .inline-canvas-native h2{font-size:var(--h2-size)}.slides-container .inline-canvas-native h3{font-size:var(--h3-size)}.slides-container .inline-canvas-native h4{font-size:var(--h4-size)}.slides-container .inline-canvas-native h5{font-size:var(--h5-size)}.slides-container .inline-canvas-native h6{font-size:var(--h6-size)}.slides-container .inline-canvas-native :is(h1,h2,h3,h4,h5,h6){text-transform:none;color:var(--text-normal);font-family:var(--font-text)}';
    style.textContent += '.inline-canvas-native .canvas-node-content.markdown-embed > .markdown-embed-content > .markdown-preview-view{padding:0 var(--size-4-4);display:flex;flex-direction:column}.inline-canvas-native .canvas-node-content .markdown-preview-view > .markdown-preview-sizer{flex:1 0 0}.inline-canvas-native .canvas-node-content .markdown-preview-section > div:not(.mod-ui):not(.markdown-preview-pusher):first-of-type > :first-child,.inline-canvas-native .canvas-node-content .markdown-preview-section > .markdown-preview-pusher + div:not(.mod-ui) > :first-child{margin-top:0!important}.inline-canvas-native .canvas-node-content .markdown-preview-section{padding:0!important}.inline-canvas-native .canvas-node-content .markdown-preview-view::before,.inline-canvas-native .canvas-node-content .markdown-preview-view::after{content:" ";display:block;min-height:min(calc(var(--canvas-node-height)*0.1 - 3px),var(--size-4-4));max-height:var(--size-4-4);flex:1 1 0}';
    root.appendChild(style);
    const picture = doc.createElement('div');
    picture.className = 'inline-canvas-native';
    root.appendChild(picture);
    const toolbar = doc.createElement('div');
    toolbar.className = 'inline-canvas-preview-toolbar';
    const edit = doc.createElement('button');
    edit.className = 'inline-canvas-edit'; edit.title = '编辑流程图'; edit.setAttribute('aria-label', '编辑流程图'); setIcon(edit, 'pencil');
    const status = doc.createElement('span');
    toolbar.append(edit); root.append(toolbar, status);
    const preview = { embed, root, picture, toolbar, status, src, sourcePath, generation: 0 };
    for (const [label, icon, action] of [
      ['放大', 'plus', p => p.canvas?.zoomBy(0.25)],
      ['缩小', 'minus', p => p.canvas?.zoomBy(-0.25)]
    ]) {
      const button = doc.createElement('button');
      button.title = label; button.setAttribute('aria-label', label); setIcon(button, icon);
      button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); action(preview); });
      toolbar.appendChild(button);
    }
    // Do not let the native editor's drop handlers import or change files in previews.
    for (const type of ['drop', 'dragover']) picture.addEventListener(type, event => { event.preventDefault(); event.stopImmediatePropagation(); }, true);
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
      if (this.activePointers?.size) { this.queuePreviewRefresh(); return; }
      for (const preview of this.previews.values()) if (preview.embed.isConnected) this.updatePreview(preview);
    }, 180);
  }

  async updatePreview(preview) {
    const generation = ++preview.generation;
    try {
      const file = this.resolvePreviewFile(preview);
      if (!file) throw new Error('找不到白板文件');
      const data = JSON.parse(await this.app.vault.cachedRead(file));
      if (generation !== preview.generation || !this.previews.has(preview.embed)) return;
      preview.embed.classList.add('inline-canvas-full-preview');
      preview.picture.style.display = '';
      if (!preview.canvas) this.createNativePreview(preview, file);
      preview.view.file = file;
      const focusId = preview.src.split('#')[1];
      const filtered = focusCanvasData(data, focusId);
      preview.canvas.setData(filtered);
      preview.canvas.setReadonly(true);
      preview.canvas.onResize();
      if (!preview.positioned) this.positionNativePreview(preview);
      preview.canvas.requestFrame();
      this.queueNativeLayout(preview);
      preview.status.textContent = ''; preview.status.className = '';
    } catch (error) {
      if (generation !== preview.generation || !this.previews.has(preview.embed)) return;
      preview.status.textContent = '预览失败：' + error.message;
      preview.status.className = 'inline-canvas-preview-error';
      // Restore native preview rather than silently showing an outdated drawing.
      this.destroyNativePreview(preview);
      preview.picture.style.display = 'none';
      preview.embed.classList.remove('inline-canvas-full-preview');
    }
  }

  removePreview(preview) {
    ++preview.generation;
    this.destroyNativePreview(preview);
    preview.root.remove();
    preview.embed.classList.remove('inline-canvas-full-preview');
  }

  createNativePreview(preview, file) {
    // The official view factory is internal. Guard it instead of relying on a
    // minified class name or globally patching Canvas/editor prototypes.
    const factory = this.app.viewRegistry?.getViewCreatorByType?.('canvas');
    const reference = this.app.workspace.getMostRecentLeaf();
    if (!factory || !reference) throw new Error('当前版本无法创建原生 Canvas 预览');
    const leaf = Object.create(reference);
    Object.defineProperties(leaf, {
      containerEl: { value: preview.embed.ownerDocument.createElement('div'), writable: true },
      updateHeader: { value: () => {} },
      detach: { value: () => {} }
    });
    let view;
    try {
      view = factory(leaf);
      preview.view = view;
      leaf.view = view;
      const canvas = view.canvas;
      if (!canvas || ['setData', 'setReadonly', 'setViewport', 'onResize', 'requestFrame', 'unload'].some(key => typeof canvas[key] !== 'function')) {
        throw new Error('Canvas 内部接口不兼容');
      }
      preview.canvas = canvas;
      const requestFrame = canvas.requestFrame.bind(canvas);
      canvas.requestFrame = (...args) => {
        this.constrainNativeViewport(preview);
        return requestFrame(...args);
      };
      // This detached view never becomes a workspace tab and cannot save files.
      view.file = file;
      view.requestSave = () => {};
      view.save = async () => {};
      view.saveLocalData = () => {};
      view.getLocalData = () => ({ readonly: true });
      const setReadonly = canvas.setReadonly.bind(canvas);
      canvas.setReadonly = () => setReadonly(true);
      Object.defineProperty(canvas, 'zoomBreakpoint', { configurable: true, get: () => -Infinity });
      preview.picture.appendChild(view.containerEl);
      // Load render children, but omit onOpen() and the global Canvas keyboard
      // hooks: this is a preview, not another active workspace editor.
      view.load();
      canvas.setReadonly(true);
      const Resize = preview.embed.ownerDocument.defaultView.ResizeObserver;
      preview.resizeObserver = new Resize(() => {
        if (!preview.canvas || !preview.embed.isConnected) return;
        preview.canvas.onResize();
        if (!preview.positioned) this.positionNativePreview(preview);
        this.queueNativeLayout(preview);
      });
      preview.resizeObserver.observe(preview.embed.parentElement || preview.picture);
      preview.contentObserver = new preview.embed.ownerDocument.defaultView.MutationObserver(() => this.queueNativeLayout(preview));
      preview.contentObserver.observe(preview.picture, { childList: true, subtree: true, characterData: true });
    } catch (error) {
      this.destroyNativePreview(preview);
      throw error;
    }
  }

  constrainNativeViewport(preview) {
    const canvas = preview.canvas;
    const nodes = canvas ? [...canvas.nodes.values()] : [];
    const bounds = preview.picture.getBoundingClientRect();
    if (!nodes.length || !bounds.width || !bounds.height) return;
    const scale = Math.pow(2, canvas.zoom || 0);
    const halfWidth = bounds.width / (2 * scale), halfHeight = bounds.height / (2 * scale);
    const minX = Math.min(...nodes.map(n => n.x)) - 24;
    const maxX = Math.max(...nodes.map(n => n.x + n.width)) + 24;
    const minY = Math.min(...nodes.map(n => n.y)) - 24;
    const maxY = Math.max(...nodes.map(n => n.y + n.height)) + 24;
    const clamp = (value, min, max, half) => max - min <= 2 * half ? (min + max) / 2 : Math.max(min + half, Math.min(max - half, value));
    canvas.x = clamp(canvas.x, minX, maxX, halfWidth);
    canvas.y = clamp(canvas.y, minY, maxY, halfHeight);
    if (Number.isFinite(canvas.tx)) canvas.tx = clamp(canvas.tx, minX, maxX, halfWidth);
    if (Number.isFinite(canvas.ty)) canvas.ty = clamp(canvas.ty, minY, maxY, halfHeight);
  }

  positionNativePreview(preview) {
    const canvas = preview.canvas;
    const bounds = preview.picture.getBoundingClientRect();
    const nodes = [...canvas.nodes.values()];
    if (!bounds.width || !bounds.height || !nodes.length) return;
    const minX = Math.min(...nodes.map(n => n.x));
    const minY = Math.min(...nodes.map(n => n.y));
    const maxX = Math.max(...nodes.map(n => n.x + n.width));
    const maxY = Math.max(...nodes.map(n => n.y + n.height));
    // Avoid fitting a wide diagram so aggressively that its text is unreadable.
    const scale = Math.max(0.85, Math.min(1, bounds.width / ((maxX - minX) * 1.1), bounds.height / ((maxY - minY) * 1.1)));
    const x = (maxX - minX) * scale > bounds.width ? minX - 24 + bounds.width / (2 * scale) : (minX + maxX) / 2;
    canvas.setViewport(x, (minY + maxY) / 2, Math.log2(scale));
    preview.positioned = true;
  }

  destroyNativePreview(preview) {
    clearTimeout(preview.layoutTimer);
    preview.contentObserver?.disconnect();
    preview.contentObserver = null;
    preview.resizeObserver?.disconnect();
    preview.resizeObserver = null;
    preview.canvas?.unload();
    preview.view?.unload();
    preview.view?.containerEl.remove();
    preview.canvas = null;
    preview.view = null;
    preview.positioned = false;
  }

  queueNativeLayout(preview) {
    clearTimeout(preview.layoutTimer);
    if (this.previewDisposed || !preview.canvas) return;
    preview.layoutTimer = setTimeout(() => {
      if (!preview.canvas || !preview.embed.isConnected || this.previewDisposed) return;
      if (this.activePointers?.size) { this.queueNativeLayout(preview); return; }
      const file = this.resolvePreviewFile(preview);
      const openEditor = this.app.workspace.getLeavesOfType?.('canvas').some(leaf => leaf.view.file?.path === file?.path);
      // An open editor owns the document: previews must never save over it.
      const fitting = openEditor ? Promise.resolve() : this.fitNativeTextCards(preview.canvas, file);
      fitting
        .then(() => this.sizeNativePreview(preview))
        .catch(error => { preview.status.textContent = '自动调整失败：' + error.message; });
    }, 120);
  }

  queueOpenCanvasFit(file) {
    if (this.previewDisposed || this.autoFitWrites.has(file.path)) return;
    clearTimeout(this.autoFitTimers.get(file.path));
    this.autoFitTimers.set(file.path, setTimeout(() => {
      this.autoFitTimers.delete(file.path);
      if (this.previewDisposed) return;
      if (this.activePointers?.size) { this.queueOpenCanvasFit(file); return; }
      for (const leaf of this.app.workspace.getLeavesOfType('canvas')) {
        if (leaf.view.file?.path === file.path && leaf.view.canvas) {
          if (leaf.view.dirty) { this.queueOpenCanvasFit(file); return; }
          this.fitNativeTextCards(leaf.view.canvas, file).catch(error => this.report(error));
          break;
        }
      }
    }, 800));
  }

  async fitNativeTextCards(canvas, file) {
    if (!file || this.autoFitWrites.has(file.path) || this.previewDisposed || this.activePointers?.size) return;
    this.autoFitWrites.add(file.path);
    try {
      const sizes = [];
      const savedData = this.app.vault.cachedRead ? JSON.parse(await this.app.vault.cachedRead(file)) : { nodes: [] };
      const savedNodes = new Map((savedData.nodes || []).map(n => [n.id, n]));
      for (const node of canvas.nodes.values()) {
        if (typeof node.text !== 'string' || typeof node.resize !== 'function') continue;
        // Render even cards outside the viewport to measure their real Markdown.
        if (!node.isAttached) node.attach();
        if (!node.child) node.render();
        const content = node.child?.previewMode?.renderer?.previewEl;
        if (!content || !content.clientWidth || !content.clientHeight || !content.querySelector('.markdown-preview-section')) continue;
        const original = node.height, originalWidth = node.width;
        const saved = savedNodes.get(node.id);
        // Never resize a live card with unsaved changes or an active text editor.
        if (saved && (saved.text !== node.text || saved.width !== originalWidth || saved.height !== original)) continue;
        const previousSizing = saved?.inlineCanvasSizing;
        const lockedWidth = !!previousSizing?.lockedWidth || (Number.isFinite(previousSizing?.width) && originalWidth !== previousSizing.width);
        const lockedHeight = !!previousSizing?.lockedHeight || (Number.isFinite(previousSizing?.height) && original !== previousSizing.height);
        if (previousSizing?.text === node.text) {
          const sizing = { ...previousSizing, width: originalWidth, height: original, lockedWidth, lockedHeight };
          if (JSON.stringify(sizing) !== JSON.stringify(previousSizing)) sizes.push({ id: node.id, text: node.text, width: originalWidth, originalWidth, original, height: original, sizing });
          continue;
        }
        const section = content.querySelector('.markdown-preview-section');
        if (!lockedWidth && section?.getBoundingClientRect) {
          const old = section.style.cssText;
          let naturalWidth;
          try {
            section.style.width = 'max-content';
            section.style.maxWidth = 'none';
            naturalWidth = section.getBoundingClientRect().width;
          } finally { section.style.cssText = old; }
          if (Number.isFinite(naturalWidth) && naturalWidth > 0) {
            const width = Math.max(180, Math.min(560, Math.ceil(naturalWidth + node.width - content.clientWidth + 24)));
            if (width !== node.width) { node.resize({ width, height: node.height }); node.render(); }
          }
        }
        for (let attempt = 0; !lockedHeight && attempt < 5; attempt++) {
          const visibleHeight = content.clientHeight;
          const previousHeight = content.style.height;
          let naturalHeight;
          try { content.style.height = '1px'; naturalHeight = content.scrollHeight; }
          finally { content.style.height = previousHeight; }
          if (!Number.isFinite(naturalHeight) || naturalHeight <= 1) break;
          const height = Math.max(64, Math.ceil(node.height + naturalHeight - visibleHeight + 1));
          if (Math.abs(height - node.height) <= 1) break;
          node.resize({ width: node.width, height });
          node.render();
        }
        const sizing = { width: node.width, height: node.height, lockedWidth, lockedHeight, text: node.text };
        if (node.height !== original || node.width !== originalWidth || JSON.stringify(previousSizing) !== JSON.stringify(sizing)) sizes.push({ id: node.id, text: node.text, width: node.width, originalWidth, original, height: node.height, sizing });
      }
      if (!sizes.length || this.previewDisposed) return;
      // Atomic merge: never overwrite newer text, manually changed dimensions,
      // node positions, connection lines, or another editor's concurrent save.
      await this.app.vault.process(file, contents => {
        const data = JSON.parse(contents);
        const changes = new Map(sizes.map(size => [size.id, size]));
        let changed = false;
        for (const node of data.nodes || []) {
          const size = changes.get(node.id);
          if (size && node.type === 'text' && node.text === size.text && node.width === size.originalWidth && node.height === size.original) {
            node.height = size.height;
            node.width = size.width;
            node.inlineCanvasSizing = size.sizing;
            changed = true;
          }
        }
        if (changed) preventCardOverlaps(data.nodes, sizes);
        return changed ? JSON.stringify(data, null, 2) : contents;
      });
    } finally { this.autoFitWrites.delete(file.path); }
  }

  sizeNativePreview(preview) {
    if (!preview.canvas || this.previewDisposed) return;
    const nodes = [...preview.canvas.nodes.values()];
    if (!nodes.length) { preview.picture.style.height = '100px'; return; }
    const width = Math.max(...nodes.map(n => n.x + n.width)) - Math.min(...nodes.map(n => n.x));
    const height = Math.max(...nodes.map(n => n.y + n.height)) - Math.min(...nodes.map(n => n.y));
    const available = preview.embed.parentElement?.clientWidth || preview.embed.clientWidth || 600;
    const desiredWidth = Math.max(240, Math.min(available, width + 48));
    const scale = Math.max(0.85, Math.min(1, (desiredWidth - 48) / Math.max(1, width)));
    const desiredHeight = Math.max(112, Math.ceil(height * scale + 48));
    const maxHeight = Math.max(240, Math.floor(preview.embed.ownerDocument.defaultView.innerHeight * 0.75));
    const cssWidth = Math.round(desiredWidth) + 'px';
    const cssHeight = Math.min(maxHeight, desiredHeight) + 'px';
    if (preview.toolbar) preview.toolbar.style.width = cssWidth;
    if (preview.picture.style.width !== cssWidth || preview.picture.style.height !== cssHeight) {
      preview.picture.style.width = cssWidth;
      preview.picture.style.height = cssHeight;
      preview.canvas.onResize();
      preview.positioned = false;
    }
    if (!preview.positioned) this.positionNativePreview(preview);
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

function focusCanvasData(data, focusId) {
  if (!data || typeof data !== 'object' || (data.nodes != null && !Array.isArray(data.nodes)) || (data.edges != null && !Array.isArray(data.edges))) {
    throw new Error('白板数据格式无效');
  }
  const nodes = data.nodes || [], edges = data.edges || [];
  if (!focusId) return { ...data, nodes, edges };
  const focus = nodes.find(node => node.id === focusId);
  if (!focus) throw new Error('找不到指定的白板卡片');
  const selected = focus.type === 'group' ? nodes.filter(node => node === focus || node.x >= focus.x && node.y >= focus.y && node.x + node.width <= focus.x + focus.width && node.y + node.height <= focus.y + focus.height) : [focus];
  const ids = new Set(selected.map(node => node.id));
  return { ...data, nodes: selected, edges: edges.filter(edge => ids.has(edge.fromNode) && ids.has(edge.toNode)) };
}

module.exports.focusCanvasData = focusCanvasData;

function preventCardOverlaps(nodes = [], sizes = []) {
  const widened = sizes.filter(size => size.width > size.originalWidth).map(size => {
    const node = nodes.find(n => n.id === size.id);
    return node?.width === size.width ? { node, oldRight: node.x + size.originalWidth } : null;
  }).filter(Boolean);
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false;
    for (const { node, oldRight } of widened) {
      for (const next of nodes) {
        if (next === node || next.type === 'group' || next.x < oldRight) continue;
        if (next.y >= node.y + node.height || next.y + next.height <= node.y) continue;
        const target = node.x + node.width + 24;
        if (next.x >= target) continue;
        const originalRight = next.x + next.width;
        next.x = target;
        if (!widened.some(entry => entry.node === next)) widened.push({ node: next, oldRight: originalRight });
        moved = true;
      }
    }
    if (!moved) break;
  }
  const grown = sizes.filter(size => size.height > size.original).map(size => {
    const node = nodes.find(n => n.id === size.id);
    return node?.height === size.height ? { node, oldBottom: node.y + size.original } : null;
  }).filter(Boolean);
  // Move downstream cards only when newly grown content would cover them.
  // Existing intentional overlaps and horizontal arrangements are preserved.
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false;
    for (const { node, oldBottom } of grown) {
      for (const next of nodes) {
        if (next === node || next.type === 'group' || next.y < oldBottom) continue;
        if (next.x >= node.x + node.width || next.x + next.width <= node.x) continue;
        const target = node.y + node.height + 24;
        if (next.y >= target) continue;
        const originalBottom = next.y + next.height;
        next.y = target;
        if (!grown.some(entry => entry.node === next)) grown.push({ node: next, oldBottom: originalBottom });
        moved = true;
      }
    }
    if (!moved) break;
  }
}

module.exports.preventCardOverlaps = preventCardOverlaps;
