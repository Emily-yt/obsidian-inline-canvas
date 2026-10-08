# Inline Canvas

An experimental Obsidian plugin that inserts an embedded Canvas into a note and opens the official Canvas editor in a side pane.

一个实验性的 Obsidian 插件：在笔记当前位置右键插入流程图，自动创建 Canvas 文件并嵌入笔记，在侧边使用官方 Canvas 编辑。

## Features / 功能

- Editor context menu and command palette action: 插入流程图白板.
- Creates a Canvas with a three-node starter flowchart.
- Inserts the embed at the cursor without replacing selected text.
- Opens the official Canvas editor in a side pane.
- Adds an edit button to Canvas embeds in reading mode.
- Stores drawings in a 流程图 folder next to the source note.

## Manual installation / 手动安装

1. Create `.obsidian/plugins/inline-canvas/` inside your vault.
2. Copy `main.js`, `manifest.json`, and `styles.css` into that folder.
3. Restart Obsidian and enable **Inline Canvas** under Community plugins.
4. Enable the built-in **Canvas** core plugin.

No build step is required. This plugin is not currently listed in the community plugin directory.

## Usage / 使用

In a Markdown note, place the cursor where the diagram should appear. Right-click and select **插入流程图白板**, or run **Inline Canvas: 插入流程图白板** from the command palette. Edit the drawing in the side pane. Canvas saves changes automatically.

在笔记编辑模式中把光标放到插入位置，右键选择“插入流程图白板”。插件会自动创建白板并插入链接，再打开侧边编辑器。阅读模式下可点击“编辑流程图”再次编辑。

## Experimental status / 实验版说明

Version 0.1.0. Syntax and mocked core-logic checks have passed; real Obsidian UI behavior and mobile compatibility have not yet been verified. Embeds are previews; editing takes place in a separate pane. Repeated edit actions currently open additional panes. Reading-mode button placement and Live Preview behavior require manual verification.

目前已通过语法与核心逻辑模拟检查，尚未完成真实 Obsidian 界面测试和移动端验证。正文显示预览，编辑在侧边进行；重复点击编辑可能增加分栏。

Disabling the plugin leaves standard `.canvas` files and embeds usable.

## License

MIT.
