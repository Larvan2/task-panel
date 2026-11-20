# Task Runner Panel

在活动栏添加一个"任务"视图，列出 `tasks.json` 里的任务，可以直接运行、停止、查看终端。

## 功能

- 列出用户级任务、`.vscode/tasks.json` 和 `.code-workspace` 里的任务，修改后自动刷新。
- 行尾按钮：运行、停止、重新运行、显示终端。
- 单击任务跳到它的终端。
- 图标显示上次运行结果，悬停显示退出码和用时。
- 右键"打开任务定义"跳到 `tasks.json` 里对应的任务。

## 构建与安装

```bash
bunx @vscode/vsce package
```

```bash
code --install-extension task-runner-panel-0.2.0.vsix
```

安装后重载窗口生效。
