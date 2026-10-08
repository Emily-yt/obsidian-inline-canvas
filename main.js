const { Plugin, Notice, TFile, normalizePath } = require('obsidian');

module.exports = class InlineCanvas extends Plugin {
  onload() {
    this.busy = false;
    this.addCommand({
      id: 'insert-canvas', name: '插入流程图白板',
      editorCallback: (editor, info) => this.insertCanvas(editor, info)
    });
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, info) => {
      if (!info.file || info.file.extension !== 'md') return;
      menu.addItem(item => item.setTitle('插入流程图白板').setIcon('layout-dashboard')
        .onClick(() => this.insertCanvas(editor, info)));
    }));
    this.registerMarkdownPostProcessor((element, context) => {
      element.querySelectorAll('.internal-embed').forEach(embed => {
        const source = embed.getAttribute('src');
        if (!source || !source.split('#')[0].endsWith('.canvas')) return;
        if (embed.querySelector('.inline-canvas-edit')) return;
        const button = document.createElement('button');
        button.className = 'inline-canvas-edit';
        button.textContent = '编辑流程图';
        button.addEventListener('click', event => {
          event.preventDefault(); event.stopPropagation();
          const file = this.app.metadataCache.getFirstLinkpathDest(source.split('#')[0], context.sourcePath);
          if (file instanceof TFile) this.openCanvas(file).catch(error => this.report(error));
          else new Notice('找不到白板文件，请检查链接。');
        });
        embed.appendChild(button);
      });
    });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && file.extension === 'canvas') {
        menu.addItem(item => item.setTitle('在旁边编辑流程图').setIcon('pencil')
          .onClick(() => this.openCanvas(file).catch(error => this.report(error))));
      }
    }));
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
      const folder = normalizePath((note.parent && note.parent.path !== '/' ? note.parent.path + '/' : '') + '流程图');
      if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
      const stamp = Date.now().toString(36);
      let path = normalizePath(folder + '/' + note.basename + '-流程图-' + stamp + '.canvas');
      let suffix = 1;
      while (this.app.vault.getAbstractFileByPath(path)) {
        path = normalizePath(folder + '/' + note.basename + '-流程图-' + stamp + '-' + suffix++ + '.canvas');
      }
      const canvas = {
        nodes: [
          { id: 'start', type: 'text', text: '开始', x: 0, y: 0, width: 220, height: 100 },
          { id: 'step', type: 'text', text: '处理步骤\n\n双击修改文字；拖动卡片边缘连接下一步。', x: 0, y: 200, width: 220, height: 140 },
          { id: 'end', type: 'text', text: '结束', x: 0, y: 440, width: 220, height: 100 }
        ],
        edges: [
          { id: 'edge1', fromNode: 'start', fromSide: 'bottom', toNode: 'step', toSide: 'top', toEnd: 'arrow' },
          { id: 'edge2', fromNode: 'step', fromSide: 'bottom', toNode: 'end', toSide: 'top', toEnd: 'arrow' }
        ]
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
