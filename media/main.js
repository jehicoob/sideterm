import xterm from './vendor/xterm-fit.mjs';
import { installFileDrop } from './drop.js';
const vscode = acquireVsCodeApi();
const rendererId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
const send = (message) => vscode.postMessage(message);
const $ = (id) => document.getElementById(id);
let config = { fontSize: 14, fontFamily: 'monospace', scrollback: 1000, cursorBlink: false, maxSessions: 6, tabMinWidth: 140, environment: '', platform: 'linux' };
const tabs = new Map();
let activeId;
let resizeTimer;
let noticeTimer;
const terminals = $('terminals');
const tabList = $('tabs');
const isMac = /Mac/.test(navigator.platform);
function theme() {
    const styles = getComputedStyle(document.body);
    const result = {};
    const colors = {
        background: ['terminal-background', 'editor-background'], foreground: ['terminal-foreground', 'editor-foreground'],
        cursor: ['terminalCursor-foreground', 'editorCursor-foreground'], cursorAccent: ['terminalCursor-background', 'editor-background'],
        selectionBackground: ['terminal-selectionBackground', 'editor-selectionBackground'],
        black: ['terminal-ansiBlack'], red: ['terminal-ansiRed'], green: ['terminal-ansiGreen'], yellow: ['terminal-ansiYellow'],
        blue: ['terminal-ansiBlue'], magenta: ['terminal-ansiMagenta'], cyan: ['terminal-ansiCyan'], white: ['terminal-ansiWhite'],
        brightBlack: ['terminal-ansiBrightBlack'], brightRed: ['terminal-ansiBrightRed'], brightGreen: ['terminal-ansiBrightGreen'],
        brightYellow: ['terminal-ansiBrightYellow'], brightBlue: ['terminal-ansiBrightBlue'], brightMagenta: ['terminal-ansiBrightMagenta'],
        brightCyan: ['terminal-ansiBrightCyan'], brightWhite: ['terminal-ansiBrightWhite']
    };
    for (const [key, tokens] of Object.entries(colors)) {
        for (const token of tokens) {
            const value = styles.getPropertyValue(`--vscode-${token}`).trim();
            if (value) {
                result[key] = value;
                break;
            }
        }
    }
    return result;
}
function current() { return activeId ? tabs.get(activeId) : undefined; }
function status() {
    const tab = current();
    $('session-count').textContent = String(tabs.size);
    $('empty').hidden = tabs.size > 0;
    terminals.hidden = tabs.size === 0;
    tabList.hidden = tabs.size === 0;
    for (const id of ['copy', 'paste', 'clear'])
        ($(id)).disabled = !tab;
    $('new').disabled = tabs.size >= config.maxSessions;
    if (!tab) {
        $('status').textContent = `${config.environment || 'Local'} · sin sesiones`;
        $('status').title = '';
        return;
    }
    const state = tab.ended ? 'Finalizada' : `${tab.terminal.cols} × ${tab.terminal.rows}`;
    $('status').textContent = `${config.environment} · ${tab.meta.processName || tab.meta.shell} · ${state}`;
    $('status').title = `${tab.meta.cwd}${tab.meta.pid ? ` · PID ${tab.meta.pid}` : ''}${tab.title ? ` · ${tab.title}` : ''}`;
}
function showNotice(message, error = false) {
    const box = $('notice');
    box.replaceChildren();
    const text = document.createElement('span');
    text.textContent = message;
    const close = document.createElement('button');
    close.textContent = '×';
    close.ariaLabel = 'Cerrar aviso';
    close.onclick = () => { box.hidden = true; };
    box.append(text, close);
    box.hidden = false;
    box.classList.toggle('error', error);
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { box.hidden = true; }, 12000);
}
function fitActive() {
    const tab = current();
    if (!tab || terminals.clientWidth < 20 || terminals.clientHeight < 20 || document.hidden)
        return;
    try {
        tab.fit.fit();
    }
    catch { /* Fonts or layout may not yet have a measurable size. */ }
    status();
}
function scheduleFit() { clearTimeout(resizeTimer); resizeTimer = setTimeout(fitActive, 70); }
function select(id, notify = true) {
    const next = tabs.get(id);
    if (!next)
        return;
    activeId = id;
    for (const [key, tab] of tabs) {
        tab.element.hidden = key !== id;
        tab.button.classList.toggle('active', key === id);
        tab.button.setAttribute('aria-selected', String(key === id));
        tab.button.tabIndex = key === id ? 0 : -1;
    }
    status();
    fitActive();
    next.terminal.focus();
    next.button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (notify)
        send({ type: 'select', id });
}
function copy(tab = current()) {
    if (!tab)
        return;
    const text = tab.terminal.getSelection();
    if (text)
        send({ type: 'clipboardWrite', id: tab.meta.id, text });
    else
        showNotice('Selecciona texto de la terminal para copiarlo.');
}
function paste(tab = current()) { if (tab && !tab.ended)
    send({ type: 'pasteRequest', id: tab.meta.id }); }
function onKey(event, tab) {
    const copyCombo = (event.ctrlKey && event.shiftKey && event.code === 'KeyC') || (isMac && event.metaKey && event.code === 'KeyC') || (event.ctrlKey && !event.shiftKey && event.code === 'KeyC' && tab.terminal.hasSelection());
    const pasteCombo = (event.ctrlKey && event.code === 'KeyV') || (isMac && event.metaKey && event.code === 'KeyV');
    if (copyCombo || pasteCombo) {
        event.preventDefault();
        event.stopPropagation();
        if (event.type === 'keydown') {
            if (copyCombo)
                copy(tab);
            else
                paste(tab);
        }
        return false;
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && /^Digit[1-9]$/.test(event.code)) {
        event.preventDefault();
        event.stopPropagation();
        if (event.type === 'keydown') {
            const id = [...tabs.keys()][Number(event.code.slice(-1)) - 1];
            if (id)
                select(id);
        }
        return false;
    }
    return true;
}
function makeTab(meta) {
    if (tabs.has(meta.id))
        return;
    const element = document.createElement('div');
    element.className = 'terminal-pane';
    element.role = 'tabpanel';
    element.id = `pane-${meta.id}`;
    const button = document.createElement('div');
    button.role = 'tab';
    button.className = 'tab';
    button.dataset.state = meta.state;
    button.id = `tab-${meta.id}`;
    button.setAttribute('aria-controls', element.id);
    element.setAttribute('aria-labelledby', button.id);
    const dot = document.createElement('span');
    dot.className = 'state-dot';
    dot.ariaHidden = 'true';
    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = meta.name;
    const close = document.createElement('button');
    close.textContent = '×';
    close.className = 'tab-close';
    close.title = 'Cerrar terminal';
    close.ariaLabel = `Cerrar ${meta.name}`;
    close.onclick = event => { event.stopPropagation(); send({ type: 'close', id: meta.id }); };
    button.append(dot, label, close);
    tabList.append(button);
    terminals.append(element);
    const terminal = new xterm.Terminal({ cols: 80, rows: 24, fontSize: config.fontSize, fontFamily: config.fontFamily,
        scrollback: config.scrollback, cursorBlink: config.cursorBlink, allowTransparency: false,
        allowProposedApi: true, theme: theme(), disableStdin: true, scrollOnUserInput: true,
        screenReaderMode: document.body.classList.contains('vscode-using-screen-reader'),
        // No automatic links or browser navigation from untrusted terminal output.
        linkHandler: { activate() { } }
    });
    const fit = new xterm.FitAddon();
    terminal.loadAddon(fit);
    const tab = { meta, terminal, fit, element, button, label, stateDot: dot, title: '', ended: false };
    tabs.set(meta.id, tab);
    terminal.open(element);
    terminal.parser.registerOscHandler(52, () => true); // Never grant OSC 52 clipboard access.
    terminal.onData(text => { if (!tab.ended)
        send({ type: 'input', id: meta.id, text }); });
    terminal.onBinary(data => { if (!tab.ended)
        send({ type: 'binary', id: meta.id, data: btoa(data) }); });
    terminal.onResize(size => { if (!tab.ended)
        send({ type: 'resize', id: meta.id, ...size }); status(); });
    terminal.onTitleChange(title => {
        const clean = title.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '').trim().slice(0, 160);
        if (clean === tab.title)
            return;
        tab.title = clean;
        // Coalesce title bursts (for example agent spinners), without delaying forever
        // while a program produces a continuous stream of changing titles.
        if (!tab.titleTimer)
            tab.titleTimer = setTimeout(() => {
                tab.titleTimer = undefined;
                if (!tab.ended && tabs.has(meta.id))
                    send({ type: 'title', id: meta.id, title: tab.title });
            }, 200);
        button.title = `${tab.meta.name}\n${tab.meta.cwd}${tab.title ? `\n${tab.title}` : ''}`;
        if (activeId === meta.id)
            status();
    });
    terminal.attachCustomKeyEventHandler(event => onKey(event, tab));
    button.onclick = () => select(meta.id);
    button.ondblclick = () => send({ type: 'rename', id: meta.id });
    button.onkeydown = event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            select(meta.id);
        }
        else if (event.key === 'Delete') {
            event.preventDefault();
            send({ type: 'close', id: meta.id });
        }
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            const keys = [...tabs.keys()], index = keys.indexOf(meta.id);
            select(keys[(index + (event.key === 'ArrowLeft' ? -1 : 1) + keys.length) % keys.length]);
            event.preventDefault();
        }
    };
    select(meta.id);
    requestAnimationFrame(() => {
        if (!tabs.has(meta.id))
            return;
        fitActive();
        send({ type: 'prepared', id: meta.id, cols: terminal.cols, rows: terminal.rows });
    });
}
function remove(id) {
    const tab = tabs.get(id);
    if (!tab)
        return;
    clearTimeout(tab.titleTimer);
    tab.ended = true;
    tab.terminal.dispose();
    tab.element.remove();
    tab.button.remove();
    tabs.delete(id);
    if (activeId === id)
        activeId = [...tabs.keys()].at(-1);
    if (activeId)
        select(activeId);
    else
        status();
}
function updateConfig(value) {
    config = value;
    const minWidth = Number.isInteger(value.tabMinWidth) ? Math.max(80, Math.min(320, value.tabMinWidth)) : 140;
    document.documentElement.style.setProperty('--sideterm-tab-min-width', `${minWidth}px`);
    for (const tab of tabs.values()) {
        tab.terminal.options.fontSize = value.fontSize;
        tab.terminal.options.fontFamily = value.fontFamily;
        tab.terminal.options.cursorBlink = value.cursorBlink;
    }
    scheduleFit();
    status();
}
const fileDrop = installFileDrop({ send, notice: showNotice, target: () => {
        const tab = current();
        return tab && !tab.ended && tab.meta.state === 'running' ? { id: tab.meta.id, name: tab.meta.name } : undefined;
    } });
window.addEventListener('message', event => {
    const msg = event.data;
    if (!msg || typeof msg.type !== 'string')
        return;
    if (fileDrop.message(msg))
        return;
    switch (msg.type) {
        case 'config':
            updateConfig(msg.config);
            break;
        case 'created':
            updateConfig(msg.config);
            makeTab(msg.session);
            break;
        case 'tabs': {
            for (const meta of msg.sessions) {
                const tab = tabs.get(meta.id);
                if (!tab)
                    continue;
                tab.meta = meta;
                tab.button.dataset.state = meta.state;
                tab.label.textContent = meta.name;
                tab.button.title = `${meta.name}\n${meta.cwd}${tab.title ? `\n${tab.title}` : ''}`;
                tab.stateDot.classList.toggle('ended', meta.state === 'exited');
                tab.terminal.options.disableStdin = meta.state !== 'running';
                tab.ended = meta.state === 'exited';
                const close = tab.button.querySelector('button');
                if (close)
                    close.ariaLabel = `Cerrar ${meta.name}`;
            }
            status();
            break;
        }
        case 'data': {
            const tab = tabs.get(msg.id);
            if (!tab) {
                send({ type: 'ack', id: msg.id, bytes: msg.bytes });
                break;
            }
            const raw = atob(msg.data), bytes = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++)
                bytes[i] = raw.charCodeAt(i);
            // ACK after parsing, not after receipt. This bounds all upstream buffers.
            tab.terminal.write(bytes, () => send({ type: 'ack', id: msg.id, bytes: msg.bytes }));
            break;
        }
        case 'ended': {
            const tab = tabs.get(msg.id);
            if (!tab)
                break;
            tab.ended = true;
            tab.terminal.options.disableStdin = true;
            tab.stateDot.classList.add('ended');
            const detail = msg.message || (msg.signal ? `Señal ${msg.signal}` : `Código ${msg.code ?? '-'}`);
            tab.terminal.write(`\r\n\x1b[0m\x1b[2m[Sesión finalizada · ${String(detail).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 300)}]\x1b[0m\r\n`);
            status();
            break;
        }
        case 'removed':
            remove(msg.id);
            break;
        case 'copy':
            copy(tabs.get(msg.id));
            break;
        case 'paste': {
            const tab = tabs.get(msg.id);
            if (tab && !tab.ended && typeof msg.text === 'string') {
                if (activeId === msg.id)
                    tab.terminal.focus();
                tab.terminal.paste(msg.text);
            }
            break;
        }
        case 'clear': {
            const tab = tabs.get(msg.id);
            if (tab) {
                tab.terminal.clear();
                tab.terminal.focus();
            }
            break;
        }
        case 'notice':
            showNotice(msg.message, !!msg.error);
            break;
        case 'visibility':
            if (msg.visible)
                scheduleFit();
            break;
    }
});
$('new').onclick = $('first').onclick = () => send({ type: 'new' });
$('copy').onclick = () => copy();
$('paste').onclick = () => paste();
$('clear').onclick = () => { const tab = current(); if (tab) {
    tab.terminal.clear();
    tab.terminal.focus();
} };
$('settings').onclick = () => send({ type: 'settings' });
document.addEventListener('paste', event => {
    const tab = current();
    if (!tab || tab.ended)
        return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const text = event.clipboardData?.getData('text/plain');
    if (text)
        send({ type: 'pasteText', id: tab.meta.id, text });
}, true);
const resizeObserver = new ResizeObserver(scheduleFit);
resizeObserver.observe(terminals);
const themeObserver = new MutationObserver(() => {
    const colors = theme();
    for (const tab of tabs.values()) {
        tab.terminal.options.theme = colors;
        tab.terminal.options.screenReaderMode = document.body.classList.contains('vscode-using-screen-reader');
    }
});
themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-vscode-theme-kind'] });
document.addEventListener('visibilitychange', () => { if (!document.hidden)
    scheduleFit(); });
window.addEventListener('beforeunload', () => {
    resizeObserver.disconnect();
    themeObserver.disconnect();
    clearTimeout(resizeTimer);
    clearTimeout(noticeTimer);
    for (const tab of tabs.values()) {
        clearTimeout(tab.titleTimer);
        tab.terminal.dispose();
    }
});
status();
send({ type: 'ready', rendererId });
