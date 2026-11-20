// @ts-check
const vscode = require('vscode');

/**
 * A task declared in tasks.json. `folder` is undefined for user tasks and for
 * tasks in a .code-workspace file, whose TaskExecution scope is a TaskScope number.
 * `key` matches keyOfTask() of the vscode.Task that VS Code builds from this entry.
 * @typedef {{ id: string, key: string, label: string, detail?: string, iconId?: string, iconColor?: string, source: 'user' | 'workspace' | 'folder', folder?: vscode.WorkspaceFolder }} TaskEntry
 */

/**
 * Run state for the current window session, keyed by TaskEntry.key.
 * `stopped` marks a run ended from this panel, whose exit code is meaningless.
 * @typedef {{ terminal?: vscode.Terminal, startedAt?: number, endedAt?: number, exitCode?: number, stopped?: boolean }} RunState
 */

/** @type {Map<string, RunState>} */
const states = new Map();

/** @param {string} key */
function stateOf(key) {
    let state = states.get(key);
    if (!state) {
        state = {};
        states.set(key, state);
    }
    return state;
}

/**
 * @param {vscode.WorkspaceFolder | undefined} folder
 * @param {string} label
 */
function makeKey(folder, label) {
    return `${folder?.uri.toString() ?? 'global'}|${label}`;
}

/** @param {vscode.Task} task */
function keyOfTask(task) {
    const scope = task.scope;
    return makeKey(typeof scope === 'object' ? scope : undefined, task.name);
}

/**
 * Reads tasks straight from configuration. vscode.tasks.fetchTasks() is avoided on
 * purpose: unfiltered it fires every onTaskType:* activation event (Go, Rust, Python...),
 * and with a type filter it drops all tasks.json tasks because CustomTask has no `type`.
 * @returns {TaskEntry[]}
 */
function readTasks() {
    /** @type {TaskEntry[]} */
    const entries = [];
    const folders = vscode.workspace.workspaceFolders ?? [];
    const root = vscode.workspace.getConfiguration().inspect('tasks');
    collect(entries, root?.globalValue, undefined, 'user');
    if (vscode.workspace.workspaceFile === undefined) {
        collect(entries, root?.workspaceValue, folders[0], 'folder');
    } else {
        collect(entries, root?.workspaceValue, undefined, 'workspace');
        for (const folder of folders) {
            const config = vscode.workspace.getConfiguration(undefined, folder.uri).inspect('tasks');
            collect(entries, config?.workspaceFolderValue, folder, 'folder');
        }
    }
    return entries;
}

/**
 * @param {TaskEntry[]} entries
 * @param {any} config
 * @param {vscode.WorkspaceFolder | undefined} folder
 * @param {TaskEntry['source']} source
 */
function collect(entries, config, folder, source) {
    if (!config || !Array.isArray(config.tasks)) {
        return;
    }
    config.tasks.forEach((/** @type {any} */ task, /** @type {number} */ index) => {
        const label = task.label ?? task.taskName;
        if (typeof label !== 'string' || task.hide === true) {
            return;
        }
        entries.push({
            id: `${source}|${folder?.uri.toString() ?? ''}|${index}`,
            key: makeKey(folder, label),
            label,
            source,
            detail: typeof task.detail === 'string' ? task.detail : undefined,
            iconId: task.icon?.id,
            iconColor: task.icon?.color,
            folder,
        });
    });
}

/**
 * @param {TaskEntry} entry
 * @returns {vscode.TaskExecution[]}
 */
function executionsOf(entry) {
    return vscode.tasks.taskExecutions.filter((execution) => keyOfTask(execution.task) === entry.key);
}

/**
 * @param {TaskEntry} entry
 * @returns {vscode.Terminal | undefined}
 */
function terminalOf(entry) {
    const terminal = states.get(entry.key)?.terminal;
    if (terminal && vscode.window.terminals.includes(terminal)) {
        return terminal;
    }
    // Runs started before this extension activated were never mapped by pid. VS Code names
    // task terminals after the label, as "label (folder)" in multi-root workspaces.
    const qualified = entry.folder ? `${entry.label} (${entry.folder.name})` : undefined;
    return vscode.window.terminals.find((t) => t.name === entry.label || t.name === qualified);
}

/** @param {TaskEntry} entry */
function runEntry(entry) {
    // `type` only limits which task providers VS Code activates; tasks.json tasks are
    // still matched by label regardless of their own type. With duplicate labels across
    // folders, VS Code runs the first match in folder order.
    return vscode.commands.executeCommand('workbench.action.tasks.runTask', {
        type: 'shell',
        task: entry.label,
    });
}

/** @param {TaskEntry} entry */
async function openDefinition(entry) {
    let editor;
    if (entry.source === 'user') {
        await vscode.commands.executeCommand('workbench.action.tasks.openUserTasks');
        editor = vscode.window.activeTextEditor;
    } else {
        const uri = entry.source === 'workspace'
            ? vscode.workspace.workspaceFile
            : entry.folder && vscode.Uri.joinPath(entry.folder.uri, '.vscode', 'tasks.json');
        if (!uri) {
            return;
        }
        editor = await vscode.window.showTextDocument(uri);
    }
    if (!editor) {
        return;
    }
    const literal = JSON.stringify(entry.label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`"(?:label|taskName)"\\s*:\\s*${literal}`).exec(editor.document.getText());
    if (!match) {
        return;
    }
    const position = editor.document.positionAt(match.index);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

/** @param {number} ms */
function formatDuration(ms) {
    const seconds = ms / 1000;
    if (seconds < 60) {
        return `${seconds.toFixed(1)} 秒`;
    }
    return `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
}

/**
 * @param {TaskEntry} entry
 * @param {RunState | undefined} state
 * @param {boolean} running
 */
function tooltipOf(entry, state, running) {
    const lines = entry.detail ? [entry.detail] : [];
    if (running && state?.startedAt !== undefined) {
        lines.push(`运行中，开始于 ${new Date(state.startedAt).toLocaleTimeString()}`);
    } else if (state?.endedAt !== undefined) {
        const result = state.stopped
            ? '已停止'
            : state.exitCode === undefined ? '已结束' : state.exitCode === 0 ? '成功' : `失败，退出码 ${state.exitCode}`;
        const duration = state.startedAt === undefined ? '' : `，用时 ${formatDuration(state.endedAt - state.startedAt)}`;
        lines.push(`上次运行：${result}${duration}，${new Date(state.endedAt).toLocaleTimeString()} 结束`);
    }
    return lines.join('\n') || undefined;
}

/**
 * @param {TaskEntry} entry
 * @param {RunState | undefined} state
 * @param {boolean} running
 */
function iconOf(entry, state, running) {
    if (running) {
        return new vscode.ThemeIcon('loading~spin');
    }
    if (state?.endedAt !== undefined) {
        if (state.stopped) {
            return new vscode.ThemeIcon('circle-slash');
        }
        if (state.exitCode === 0) {
            return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
        }
        if (state.exitCode !== undefined) {
            return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
        }
        // No process exit code: a dependsOn-only task, or a CustomExecution.
        return new vscode.ThemeIcon('check');
    }
    return new vscode.ThemeIcon(
        entry.iconId ?? 'circle-large-outline',
        entry.iconColor ? new vscode.ThemeColor(entry.iconColor) : undefined,
    );
}

/** @implements {vscode.TreeDataProvider<TaskEntry>} */
class TaskTreeProvider {
    constructor() {
        /** @type {vscode.EventEmitter<void>} */
        this.changed = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.changed.event;
    }

    refresh() {
        this.changed.fire();
    }

    getChildren() {
        return readTasks();
    }

    /** @param {TaskEntry} entry */
    getTreeItem(entry) {
        const running = executionsOf(entry).length > 0;
        const terminal = terminalOf(entry);
        const state = states.get(entry.key);
        const item = new vscode.TreeItem(entry.label);
        item.id = entry.id;
        item.description = entry.detail;
        item.tooltip = tooltipOf(entry, state, running);
        item.iconPath = iconOf(entry, state, running);
        // Space-separated flags, matched with `viewItem =~ /\bflag\b/` in package.json.
        item.contextValue = `${running ? 'running' : 'idle'}${terminal ? ' terminal' : ''}`;
        if (terminal) {
            item.command = { command: 'taskPanel.showTerminal', title: '显示终端', arguments: [entry] };
        }
        return item;
    }
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
    const provider = new TaskTreeProvider();
    const refresh = () => provider.refresh();
    /** Keys of tasks to start again once their current run ends. */
    const pendingRestart = new Set();

    /** @param {TaskEntry} entry */
    const stop = (entry) => {
        const executions = executionsOf(entry);
        if (executions.length > 0) {
            stateOf(entry.key).stopped = true;
        }
        for (const execution of executions) {
            execution.terminate();
        }
        return executions.length > 0;
    };

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('taskPanel.tasks', provider),
        vscode.commands.registerCommand('taskPanel.run', runEntry),
        vscode.commands.registerCommand('taskPanel.stop', stop),
        vscode.commands.registerCommand('taskPanel.restart', (/** @type {TaskEntry} */ entry) => {
            if (stop(entry)) {
                pendingRestart.add(entry.key);
            } else {
                runEntry(entry);
            }
        }),
        vscode.commands.registerCommand('taskPanel.showTerminal', (/** @type {TaskEntry} */ entry) => {
            terminalOf(entry)?.show();
        }),
        vscode.commands.registerCommand('taskPanel.openDefinition', openDefinition),
        vscode.tasks.onDidStartTask((e) => {
            const state = stateOf(keyOfTask(e.execution.task));
            state.startedAt = Date.now();
            state.endedAt = undefined;
            state.exitCode = undefined;
            state.stopped = false;
            refresh();
        }),
        // The task's shell is the terminal's own process, so the pids are equal.
        vscode.tasks.onDidStartTaskProcess(async (e) => {
            for (const terminal of vscode.window.terminals) {
                if ((await terminal.processId) === e.processId) {
                    stateOf(keyOfTask(e.execution.task)).terminal = terminal;
                    refresh();
                    return;
                }
            }
        }),
        vscode.tasks.onDidEndTaskProcess((e) => {
            stateOf(keyOfTask(e.execution.task)).exitCode = e.exitCode;
            refresh();
        }),
        // The ext host removes an execution from taskExecutions before firing onDidEndTask.
        vscode.tasks.onDidEndTask((e) => {
            const task = e.execution.task;
            const key = keyOfTask(task);
            stateOf(key).endedAt = Date.now();
            if (pendingRestart.delete(key)) {
                vscode.commands.executeCommand('workbench.action.tasks.runTask', { type: 'shell', task: task.name });
            }
            refresh();
        }),
        vscode.window.onDidOpenTerminal(refresh),
        vscode.window.onDidCloseTerminal(refresh),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('tasks')) {
                refresh();
            }
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    );
}

module.exports = { activate };
