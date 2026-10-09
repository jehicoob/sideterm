import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { vscode, DataTransfer, Disposable, ExtensionContext, OutputChannel, Uri, WebviewView } from './api';
import { PtyBridge, HostMessage } from './bridge';
import { cleanTitle, tabName } from './titles';
import { resolveDropPaths, quoteShellPath, DroppedRef, PathEnvironment } from './dropPaths';
import { DropStore, validateDropFiles } from './dropStore';

const VIEW_ID = 'sideterm.sessions';
const DROP_VIEW_ID = 'sideterm.drop';
const MAX_CLIPBOARD = 128 * 1024;
const WINDOW = 131072;
type State = 'preparing' | 'starting' | 'running' | 'exited';
interface Session {
  id: string; name: string; cwd: string; shell: string; args: string[];
  state: State; cols: number; rows: number; pid?: number;
  outstanding: number; code?: number | null; signal?: number | null;
  readyTimer?: NodeJS.Timeout; spawnRequested?: boolean;
  processName?: string; foreground?: boolean; foregroundKey?: string;
  sequenceTitle?: string; customName?: string;
}
function messageObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function boundedNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}
function executable(file: string): boolean {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
}
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]!));
}

export class SideTermProvider implements Disposable {
  private view?: WebviewView;
  private viewListeners: Disposable[] = [];
  private listeners: Disposable[] = [];
  private rendererId?: string;
  private rendererReady = false;
  private creating = false;
  private shuttingDown = false;
  private sessions = new Map<string, Session>();
  private activeId?: string;
  private bridge: PtyBridge;
  private log: OutputChannel;
  private waiters: Array<() => void> = [];
  private closeAllInProgress = false;
  private resetNotice = false;
  private generation = 0;
  private dropStore = new DropStore();
  private dropOperation = false;

  constructor(private readonly context: ExtensionContext) {
    this.log = vscode.window.createOutputChannel('SideTerm Local');
    this.bridge = new PtyBridge(path.join(context.extensionPath, 'python', 'pty_host.py'), () => this.pythonPath());
    this.bridge.on('message', (msg: HostMessage) => this.onHostMessage(msg));
    this.bridge.on('stopped', (info: {expected: boolean; code?: number; signal?: string}) => {
      for (const session of this.sessions.values()) {
        if (session.state === 'running' || (session.state === 'starting' && session.spawnRequested)) {
          session.state = 'exited'; session.outstanding = 0;
          this.post({type: 'ended', id: session.id, code: null, signal: null, message: 'El motor PTY se detuvo.'});
        }
      }
      if (!info.expected && !this.shuttingDown) this.log.appendLine('[motor] El proceso PTY se cerró.');
      this.updateTabs();
    });
    this.listeners.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('sideterm') || event.affectsConfiguration('terminal.integrated') || event.affectsConfiguration('editor.fontFamily')) {
        this.post({type: 'config', config: this.uiConfig()});
      }
    }));
  }

  resolveWebviewView(view: WebviewView): void {
    this.viewListeners.forEach(d => d.dispose()); this.viewListeners = [];
    this.view = view; this.rendererReady = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    view.webview.html = this.html(view);
    this.viewListeners.push(view.webview.onDidReceiveMessage(raw => {
      void this.onMessage(raw).catch(error => this.report(error));
    }));
    this.viewListeners.push(view.onDidChangeVisibility(() => {
      this.post({type: 'visibility', visible: view.visible});
      this.bridge.send({type: 'visibility', visible: view.visible});
    }));
    this.viewListeners.push(view.onDidDispose(() => {
      if (this.view !== view) return;
      this.view = undefined; this.rendererReady = false;
      if (this.sessions.size) {
        this.resetNotice = true;
        void this.endAll(false);
      }
    }));
  }

  private config() { return vscode.workspace.getConfiguration('sideterm'); }
  private pythonPath(): string {
    const configured = this.config().get<string>('pythonPath', '').trim();
    if (configured) return configured;
    return executable('/usr/bin/python3') ? '/usr/bin/python3' : 'python3';
  }
  private shell(): {file: string; args: string[]} {
    const configured = this.config().get<string>('shell', '').trim();
    const candidate = configured || (process.env.SHELL && executable(process.env.SHELL) ? process.env.SHELL : '/bin/bash');
    if (!path.isAbsolute(candidate) || !executable(candidate)) {
      throw new Error(`Shell no válido: ${candidate}. Configura una ruta absoluta, por ejemplo /usr/bin/zsh, en sideterm.shell (WSL).`);
    }
    const args = this.config().get<unknown>('shellArgs', ['-i']);
    if (!Array.isArray(args) || args.length > 32 || args.some(a => typeof a !== 'string' || a.includes('\0') || a.length > 4096)) {
      throw new Error('sideterm.shellArgs debe ser una lista de argumentos de texto.');
    }
    return {file: candidate, args: args as string[]};
  }
  private uiConfig() {
    const native = vscode.workspace.getConfiguration('terminal.integrated');
    const fontSize = this.config().get<number>('fontSize', 0) || native.get<number>('fontSize', 14);
    return {
      fontSize: boundedNumber(fontSize, 8, 32, 14),
      fontFamily: native.get<string>('fontFamily', '') || vscode.workspace.getConfiguration('editor').get<string>('fontFamily', 'monospace'),
      scrollback: boundedNumber(this.config().get<number>('scrollback', 1000), 0, 10000, 1000),
      cursorBlink: this.config().get<boolean>('cursorBlink', false),
      maxSessions: boundedNumber(this.config().get<number>('maxSessions', 6), 1, 12, 6),
      tabMinWidth: boundedNumber(this.config().get<number>('tabMinWidth', 140), 80, 320, 140),
      environment: vscode.env.remoteName === 'wsl' ? 'WSL' : (vscode.env.remoteName || os.platform()),
      // The renderer may run on Windows while this extension host runs in WSL.
      platform: process.platform
    };
  }
  private metadata(s: Session) {
    return {id: s.id, name: s.name, cwd: s.cwd, shell: path.basename(s.shell), processName: s.processName, customName: s.customName,
      state: s.state, pid: s.pid, code: s.code, signal: s.signal};
  }
  private updateTabs(): void {
    this.post({type: 'tabs', sessions: [...this.sessions.values()].map(s => this.metadata(s)), activeId: this.activeId});
  }
  private post(message: unknown): void {
    if (!this.view || !this.rendererReady) return;
    const target = this.view;
    void Promise.resolve(target.webview.postMessage(message)).then(delivered => {
      if (!delivered && this.view === target && this.sessions.size && !this.shuttingDown) {
        this.log.appendLine('[vista] Canal de la terminal no disponible; se cierran las sesiones para no dejar procesos inaccesibles.');
        this.rendererReady = false; this.resetNotice = true;
        void this.endAll(false);
      }
    }, error => this.log.appendLine(`[vista] ${errorText(error)}`));
  }
  report(error: unknown): void {
    const message = errorText(error);
    this.log.appendLine(`[error] ${message}`);
    this.post({type: 'notice', message, error: true});
    void vscode.window.showErrorMessage(`SideTerm: ${message}`);
  }
  async show(): Promise<void> {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    this.view?.show(false);
  }
  private async ensureReady(): Promise<void> {
    await this.show();
    if (this.rendererReady) return;
    await new Promise<void>((resolve, reject) => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(item => item !== done);
        reject(new Error('No se pudo cargar la vista. Abre SideTerm desde su icono y vuelve a pulsar +.'));
      }, 8000);
      this.waiters.push(done);
    });
  }
  private async chooseFolder(): Promise<string | undefined> {
    const roots = vscode.workspace.workspaceFolders ?? [];
    if (roots.length === 1) return roots[0].uri.fsPath;
    if (roots.length > 1) {
      const entries: Array<{label: string; description: string; uri?: Uri}> = roots.map(root => ({label: root.name, description: root.uri.fsPath, uri: root.uri}));
      entries.push({label: 'Otra carpeta…', description: 'Seleccionar una carpeta de WSL/Linux'});
      const chosen = await vscode.window.showQuickPick(entries, {placeHolder: 'Carpeta inicial de esta terminal', ignoreFocusOut: true});
      if (!chosen) return undefined;
      if (chosen.uri) return chosen.uri.fsPath;
    }
    const chosen = await vscode.window.showOpenDialog({canSelectFiles: false, canSelectFolders: true,
      canSelectMany: false, openLabel: 'Abrir terminal aquí', defaultUri: vscode.Uri.file(os.homedir())});
    return chosen?.[0]?.fsPath;
  }

  async newSession(): Promise<void> {
    if (this.creating || this.closeAllInProgress || this.shuttingDown) return;
    this.creating = true;
    const generation = this.generation;
    try {
      if (!vscode.workspace.isTrusted) throw new Error('Abre un workspace de confianza para ejecutar terminales.');
      if (process.platform !== 'linux') throw new Error('Esta primera versión está preparada para WSL/Linux. Abre la ventana con “WSL: Reopen Folder in WSL” e instala la extensión allí.');
      await this.ensureReady();
      const maximum = this.uiConfig().maxSessions;
      if (this.sessions.size >= maximum) throw new Error(`Límite de ${maximum} pestañas. Cierra alguna o ajusta sideterm.maxSessions.`);
      const cwd = await this.chooseFolder();
      if (!cwd) return;
      const {file, args} = this.shell();
      const stat = await fs.promises.stat(cwd);
      if (!stat.isDirectory()) throw new Error('La carpeta inicial ya no existe.');
      if (this.shuttingDown || !this.rendererReady || this.closeAllInProgress || generation !== this.generation) return;
      const session: Session = {
        id: randomUUID(), name: tabName({cwd, shell: file}), processName: path.basename(file),
        cwd, shell: file, args, state: 'preparing', cols: 80, rows: 24, outstanding: 0
      };
      this.sessions.set(session.id, session); this.activeId = session.id;
      session.readyTimer = setTimeout(() => {
        if (session.state === 'preparing') {
          this.sessions.delete(session.id); this.post({type: 'removed', id: session.id}); this.updateTabs();
          this.report(new Error('No se pudo preparar la terminal visual. No se inició ningún shell.'));
        }
      }, 8000);
      this.post({type: 'created', session: this.metadata(session), config: this.uiConfig()});
      this.updateTabs();
    } catch (error) { this.report(error); }
    finally { this.creating = false; }
  }

  private async spawnSession(session: Session, message: Record<string, unknown>): Promise<void> {
    if (session.state !== 'preparing') return;
    clearTimeout(session.readyTimer); session.readyTimer = undefined;
    session.cols = boundedNumber(message.cols, 2, 500, 80);
    session.rows = boundedNumber(message.rows, 1, 200, 24);
    session.state = 'starting'; this.updateTabs();
    try {
      await this.bridge.start();
      if (!this.sessions.has(session.id) || this.shuttingDown) { await this.stopIfIdle(); return; }
      this.bridge.send({type: 'visibility', visible: this.view?.visible ?? false});
      session.spawnRequested = true;
      if (!this.bridge.send({type: 'spawn', id: session.id, shell: session.shell, args: session.args,
        cwd: session.cwd, cols: session.cols, rows: session.rows})) throw new Error('El motor PTY no está disponible.');
    } catch (error) {
      if (!this.sessions.has(session.id)) return;
      session.state = 'exited';
      this.post({type: 'ended', id: session.id, message: errorText(error)});
      this.updateTabs(); this.report(error);
    }
  }

  private onHostMessage(message: HostMessage): void {
    const session = message.id ? this.sessions.get(message.id) : undefined;
    if (message.type === 'data') {
      if (!session || session.state === 'exited') {
        if (message.id && message.bytes) this.bridge.send({type: 'ack', id: message.id, bytes: message.bytes});
        return;
      }
      if (typeof message.data !== 'string' || typeof message.bytes !== 'number' || message.bytes < 1 || message.bytes > 16384) return;
      session.outstanding += message.bytes;
      if (session.outstanding > WINDOW) { this.report(new Error('Se excedió el límite de salida de una sesión.')); void this.closeSession(session.id, false); return; }
      this.post({type: 'data', id: session.id, data: message.data, bytes: message.bytes});
    } else if (message.type === 'metadata' && session && session.state !== 'exited') {
      if (typeof message.cwd !== 'string' || !path.isAbsolute(message.cwd) || message.cwd.length > 32768 || message.cwd.includes('\0') ||
          typeof message.process !== 'string' || message.process.length > 160 || typeof message.foreground !== 'boolean' ||
          typeof message.foregroundKey !== 'string' || message.foregroundKey.length > 200) return;
      if (message.foregroundKey !== session.foregroundKey || !message.foreground) session.sequenceTitle = '';
      if (message.foreground && typeof message.title === 'string' && message.title.length <= 512) session.sequenceTitle = cleanTitle(message.title);
      session.cwd = message.cwd; session.processName = cleanTitle(message.process, 96);
      session.foreground = message.foreground; session.foregroundKey = message.foregroundKey;
      session.name = tabName(session); this.updateTabs();
    } else if (message.type === 'spawned' && session) {
      session.state = 'running'; session.pid = message.pid; this.updateTabs();
      this.log.appendLine(`[sesión] PID ${session.pid}: ${path.basename(session.shell)}`);
    } else if (message.type === 'exit' && session) {
      session.state = 'exited'; session.outstanding = 0; session.code = message.code; session.signal = message.signal;
      this.post({type: 'ended', id: session.id, code: session.code, signal: session.signal});
      this.updateTabs(); void this.stopIfIdle();
    } else if (message.type === 'error') {
      if (message.operation === 'spawn' && session) {
        session.state = 'exited'; this.post({type: 'ended', id: session.id, message: message.message}); this.updateTabs();
        void this.stopIfIdle();
      }
      this.report(new Error(message.message ?? 'Error del motor PTY.'));
    }
  }
  private async stopIfIdle(): Promise<void> {
    if (![...this.sessions.values()].some(s => s.state !== 'exited')) await this.bridge.stop();
  }
  private active(): Session | undefined { return this.activeId ? this.sessions.get(this.activeId) : undefined; }

  async closeSession(id = this.activeId, confirm = true): Promise<void> {
    const session = id ? this.sessions.get(id) : undefined;
    if (!session) return;
    if (confirm && session.state !== 'exited' && this.config().get('confirmClose', true)) {
      const answer = await vscode.window.showWarningMessage(`¿Cerrar “${session.name}”?`,
        {modal: true, detail: 'Se terminará el shell y los procesos asociados a esta terminal, incluidos los agentes que estén trabajando.'}, 'Cerrar terminal');
      if (answer !== 'Cerrar terminal') return;
    }
    clearTimeout(session.readyTimer);
    this.bridge.send({type: 'close', id: session.id});
    this.sessions.delete(session.id);
    if (this.activeId === session.id) this.activeId = [...this.sessions.keys()].at(-1);
    this.post({type: 'removed', id: session.id}); this.updateTabs();
    await this.clearDroppedFiles(session.id);
    await this.stopIfIdle();
  }
  async endAll(confirm = true): Promise<void> {
    if (this.closeAllInProgress && confirm) return;
    this.closeAllInProgress = true;
    try {
      const running = [...this.sessions.values()].filter(s => s.state !== 'exited').length;
      if (confirm && running) {
        const answer = await vscode.window.showWarningMessage(`¿Cerrar ${running} terminal(es) en ejecución?`,
          {modal: true, detail: 'Los agentes y comandos de esas sesiones se detendrán.'}, 'Cerrar todas');
        if (answer !== 'Cerrar todas') return;
      }
      this.generation++;
      for (const session of this.sessions.values()) {
        clearTimeout(session.readyTimer); this.post({type: 'removed', id: session.id});
      }
      this.sessions.clear(); this.activeId = undefined; this.updateTabs();
      await this.clearDroppedFiles();
      await this.bridge.stop();
    } finally { this.closeAllInProgress = false; }
  }
  async rename(id = this.activeId): Promise<void> {
    const s = id ? this.sessions.get(id) : undefined;
    if (!s) return;
    const name = await vscode.window.showInputBox({prompt: 'Nombre personalizado, sin carpeta. Déjalo vacío para volver al nombre automático.', value: s.customName || '', ignoreFocusOut: true,
      validateInput: value => value.trim().length > 80 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value) ? 'Usa hasta 80 caracteres sin controles ni saltos de línea.' : undefined});
    if (name !== undefined && this.sessions.has(s.id)) {
      s.customName = cleanTitle(name, 80) || undefined; s.name = tabName(s); this.updateTabs();
    }
  }
  resetName(id = this.activeId): void {
    const s = id ? this.sessions.get(id) : undefined;
    if (s) { s.customName = undefined; s.name = tabName(s); this.updateTabs(); }
  }
  async focusTerminal(): Promise<void> { await this.show(); this.post({type: 'focus'}); }
  copy(): void { this.post({type: 'copy', id: this.activeId}); }
  clear(): void { this.post({type: 'clear', id: this.activeId}); }
  async paste(id = this.activeId, supplied?: string): Promise<void> {
    const s = id ? this.sessions.get(id) : undefined;
    if (!s || (s.state !== 'running' && s.state !== 'starting')) return;
    const text = supplied ?? await vscode.env.clipboard.readText();
    if (!text) return;
    if (Buffer.byteLength(text, 'utf8') > MAX_CLIPBOARD) throw new Error('El pegado supera 128 KiB. Usa un archivo para contenidos de ese tamaño.');
    if (/[\r\n]/.test(text) && this.config().get('confirmMultilinePaste', true)) {
      const answer = await vscode.window.showWarningMessage('El texto contiene saltos de línea. ¿Pegar en la terminal?',
        {modal: true, detail: 'Según el programa activo, los saltos de línea podrían ejecutar comandos. No se muestra el contenido para evitar exponer datos sensibles.'}, 'Pegar');
      if (answer !== 'Pegar') return;
    }
    if (this.sessions.has(s.id)) this.post({type: 'paste', id: s.id, text});
  }
  private async clearDroppedFiles(sessionId?: string): Promise<void> {
    try {if (sessionId) await this.dropStore.clearSession(sessionId); else await this.dropStore.dispose();}
    catch {this.log.appendLine('[archivos] No se pudieron eliminar algunas copias temporales. El cierre de terminales continúa. Revisa los directorios temporales sideterm-drop- de esta sesión.');}
  }
  private pathEnvironment(): PathEnvironment {
    const authorities = (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme === 'vscode-remote').map(f => f.uri.authority || '');
    return {wsl: vscode.env.remoteName === 'wsl' || !!process.env.WSL_DISTRO_NAME, distro: process.env.WSL_DISTRO_NAME, authorities};
  }
  /** Native drop zone and Explorer menu: the workbench never forwards these drags into the webview iframe. */
  async insertPaths(refs: DroppedRef[]): Promise<void> {
    const session = this.active();
    if (!session || session.state !== 'running') throw new Error('Abre o selecciona una pestaña de SideTerm en ejecución antes de insertar rutas.');
    if (!vscode.workspace.isTrusted) throw new Error('Abre un workspace de confianza para insertar rutas.');
    if (this.dropOperation) throw new Error('Ya hay una operación de arrastre en curso.');
    this.dropOperation = true;
    const generation = this.generation;
    try {
      const paths = await resolveDropPaths(refs, this.pathEnvironment());
      if (this.generation !== generation || this.sessions.get(session.id) !== session || session.state !== 'running')
        throw new Error('La pestaña de destino se cerró antes de insertar las rutas. No se insertaron en otra pestaña.');
      const text = paths.map(quoteShellPath).join(' ') + ' ';
      if (Buffer.byteLength(text, 'utf8') > MAX_CLIPBOARD) throw new Error('El conjunto de rutas supera 128 KiB.');
      this.view?.show(false);
      this.post({type: 'paste', id: session.id, text}); // No CR/LF/Enter.
    } finally { this.dropOperation = false; }
  }
  async onNativeDrop(dataTransfer: DataTransfer): Promise<void> {
    const list = await dataTransfer.get('text/uri-list')?.asString();
    const refs: DroppedRef[] = (list || '').split(/\r?\n/).map(line => line.trim())
      .filter(line => line && !line.startsWith('#')).map(value => ({kind: 'uri', value}));
    await this.insertPaths(refs);
  }
  private async onFileDrop(msg: Record<string, unknown>): Promise<void> {
    if (typeof msg.requestId !== 'string' || msg.requestId.length > 100) return;
    const reply = (fields: Record<string, unknown>) => this.post({type:'fileDropResult',requestId:msg.requestId,...fields});
    const session = typeof msg.id === 'string' ? this.sessions.get(msg.id) : undefined;
    if (!session || session.state !== 'running' || !vscode.workspace.isTrusted) {reply({ok:false,error:'La terminal de destino ya no está disponible o el workspace no es de confianza.'});return;}
    if (this.dropOperation) {reply({ok:false,error:'Ya hay una operación de arrastre en curso.'});return;}
    this.dropOperation = true;
    const generation=this.generation;
    const valid=() => this.generation===generation && this.sessions.get(session.id)===session && session.state==='running' && vscode.workspace.isTrusted;
    const insert=(paths:string[],copied=false) => {
      if (!valid()) throw new Error('La sesión original se cerró durante el arrastre. No se insertaron archivos en otra pestaña.');
      const text=paths.map(quoteShellPath).join(' ')+' ';
      if (Buffer.byteLength(text,'utf8')>MAX_CLIPBOARD) throw new Error('El conjunto de rutas supera 128 KiB.');
      this.post({type:'paste',id:session.id,text}); // No CR/LF/Enter; bracketed paste is handled by xterm.
      if (copied) this.post({type:'notice',message:'Se insertaron las rutas de copias temporales, no de los originales. Se borran al cerrar esta pestaña. Solo se copiaron los archivos que arrastraste.'});
    };
    try {
      switch (msg.action) {
        case 'paths': {
          const paths=await resolveDropPaths(msg.refs,this.pathEnvironment());
          insert(paths);reply({ok:true});break;
        }
        case 'begin': {
          const files=validateDropFiles(msg.files);
          const answer=await vscode.window.showWarningMessage('El arrastre no expone la ruta original. ¿Copiar los archivos arrastrados a WSL/Linux?',
            {modal:true,detail:`Se copiarán solo ${files.length} archivo(s) que acabas de soltar, en una carpeta temporal privada. El agente recibirá esas copias, no los originales. Se eliminarán al cerrar la pestaña. No se adjunta el archivo abierto en el editor.`},'Copiar archivos arrastrados');
          if (answer!=='Copiar archivos arrastrados') {reply({ok:true,cancelled:true});break;}
          if (!valid()) throw new Error('La terminal se cerró mientras confirmabas el arrastre.');
          const transfer=await this.dropStore.begin(session.id,files);
          if (!valid()) {await this.dropStore.clearSession(session.id);throw new Error('La terminal ya no está disponible.');}
          reply({ok:true,...transfer});break;
        }
        case 'chunk': await this.dropStore.chunk(session.id,msg.uploadId,msg.index,msg.offset,msg.data);reply({ok:true});break;
        case 'finish': {const paths=await this.dropStore.finish(session.id,msg.uploadId);insert(paths,true);reply({ok:true});break;}
        case 'cancel': await this.dropStore.cancel(msg.uploadId);reply({ok:true});break;
        default: throw new Error('Operación de arrastre no reconocida.');
      }
    } catch (error) {reply({ok:false,error:errorText(error)});}
    finally {this.dropOperation=false;}
  }
  private async onMessage(raw: unknown): Promise<void> {
    const msg = messageObject(raw);
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'ready' && typeof msg.rendererId === 'string') {
      if (this.rendererId && this.rendererId !== msg.rendererId && this.sessions.size) {
        this.resetNotice = true; await this.endAll(false);
      }
      this.rendererId = msg.rendererId; this.rendererReady = true;
      this.post({type: 'config', config: this.uiConfig()}); this.updateTabs();
      if (this.resetNotice) {
        this.post({type: 'notice', message: 'La vista se recargó y sus sesiones se cerraron. Abre una nueva con +. Ocultar la barra normalmente no recarga la vista.', error: false});
        this.resetNotice = false;
      }
      this.waiters.splice(0).forEach(done => done()); return;
    }
    if (!this.rendererReady) return;
    if (msg.type === 'fileDrop') {await this.onFileDrop(msg);return;}
    if (msg.type === 'new') { await this.newSession(); return; }
    if (msg.type === 'settings') { await this.settings(); return; }
    if (msg.type === 'diagnostics') { await this.diagnostics(); return; }
    const s = typeof msg.id === 'string' ? this.sessions.get(msg.id) : undefined;
    if (!s) return;
    switch (msg.type) {
      case 'prepared': await this.spawnSession(s, msg); break;
      case 'select': this.activeId = s.id; break;
      case 'close': await this.closeSession(s.id); break;
      case 'rename': await this.rename(s.id); break;
      case 'title': {
        if (typeof msg.title !== 'string' || msg.title.length > 512 || s.state === 'exited') break;
        // Pair title hints with the next actual foreground/CWD snapshot, not
        // with stale metadata from the shell before the command was launched.
        this.bridge.send({type: 'title', id: s.id, title: cleanTitle(msg.title)});
        break;
      }
      case 'input': {
        if ((s.state !== 'running' && s.state !== 'starting') || typeof msg.text !== 'string' || msg.text.length > 128 * 1024) break;
        const data = Buffer.from(msg.text, 'utf8');
        if (data.length > 256 * 1024) break;
        if (!this.bridge.send({type: 'input', id: s.id, data: data.toString('base64')})) throw new Error('Entrada temporalmente llena. Espera antes de volver a pegar.');
        break;
      }
      case 'binary': {
        if ((s.state !== 'running' && s.state !== 'starting') || typeof msg.data !== 'string' || msg.data.length > 16384 || !/^[A-Za-z0-9+/]*={0,2}$/.test(msg.data)) break;
        this.bridge.send({type: 'input', id: s.id, data: msg.data}); break;
      }
      case 'ack': {
        if (typeof msg.bytes !== 'number' || !Number.isInteger(msg.bytes) || msg.bytes <= 0 || msg.bytes > s.outstanding) break;
        s.outstanding -= msg.bytes; this.bridge.send({type: 'ack', id: s.id, bytes: msg.bytes}); break;
      }
      case 'resize': {
        const cols = boundedNumber(msg.cols, 2, 500, s.cols), rows = boundedNumber(msg.rows, 1, 200, s.rows);
        if (cols !== s.cols || rows !== s.rows) {
          s.cols = cols; s.rows = rows; this.bridge.send({type: 'resize', id: s.id, cols, rows});
        }
        break;
      }
      case 'clipboardWrite':
        if (typeof msg.text === 'string' && Buffer.byteLength(msg.text, 'utf8') <= 1024 * 1024) await vscode.env.clipboard.writeText(msg.text);
        break;
      case 'pasteRequest': await this.paste(s.id); break;
      case 'pasteText': if (typeof msg.text === 'string') await this.paste(s.id, msg.text); break;
    }
  }
  async settings(): Promise<void> { await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:jehicoob-local.sideterm-local'); }
  async diagnostics(): Promise<void> {
    this.log.appendLine('\n=== SideTerm Local 0.1.5 ===');
    this.log.appendLine(`VS Code: ${vscode.version}; host: ${process.platform}/${process.arch}; remoto: ${vscode.env.remoteName ?? 'no'}`);
    this.log.appendLine(`Node del extension host: ${process.version}; Python: ${this.bridge.pythonVersion || 'no iniciado'}`);
    this.log.appendLine(`Motor PTY: ${this.bridge.pid ?? 'apagado'}; pestañas: ${this.sessions.size}; historial por nueva pestaña: ${this.uiConfig().scrollback}`);
    if (this.bridge.pid && process.platform === 'linux') {
      try {
        const status = await fs.promises.readFile(`/proc/${this.bridge.pid}/status`, 'utf8');
        const rss = status.match(/^VmRSS:\s+(.+)$/m)?.[1];
        if (rss) this.log.appendLine(`RSS del ayudante Python (no incluye shells, agentes ni la vista): ${rss}`);
      } catch { /* process may finish while inspecting */ }
    }
    for (const s of this.sessions.values()) this.log.appendLine(`  ${s.name}: ${s.state}; PID ${s.pid ?? '-'}; ${s.cols}x${s.rows}; salida pendiente ${s.outstanding} B`);
    this.log.appendLine('Nombres/rutas: consulta compartida cada 1 s, suspendida con la vista oculta; mínimo de pestaña: ' + this.uiConfig().tabMinWidth + ' px.');
    this.log.appendLine('Arrastre: solo referencias explícitas; copias sin ruta requieren confirmación y bloques de 64 KiB. Sin editor activo ni contexto automático.');
    this.log.appendLine('Desde el Explorador: vista “Soltar archivos” o menú contextual “Insertar ruta en SideTerm”, siempre en la pestaña activa.');
    this.log.appendLine('Sin telemetría, sockets de escucha ni registro de comandos. El consumo de los agentes es independiente.');
    this.log.show(true);
  }
  private html(view: WebviewView): string {
    const resource = (file: string) => escapeHtml(view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file)).toString());
    const nonce = randomBytes(24).toString('base64');
    const csp = view.webview.cspSource;
    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${csp} 'nonce-${nonce}'; style-src ${csp} 'unsafe-inline'; img-src ${csp} data:; font-src ${csp}; connect-src 'none'; base-uri 'none'; form-action 'none';">
<title>SideTerm Local</title><link rel="stylesheet" href="${resource('vendor/xterm.css')}"><link rel="stylesheet" href="${resource('style.css')}"></head>
<body><main id="app"><div id="toolbar"><div class="brand"><span class="brand-mark" aria-hidden="true">›_</span><span>SideTerm</span><span id="session-count" class="count">0</span></div><div class="actions">
<button id="copy" class="icon-button" title="Copiar selección (Ctrl+Shift+C)" aria-label="Copiar selección">⧉</button><button id="paste" class="icon-button" title="Pegar (Ctrl+Shift+V)" aria-label="Pegar">↧</button><button id="clear" class="icon-button" title="Limpiar historial" aria-label="Limpiar historial">⌁</button><button id="new" class="icon-button primary" title="Nueva terminal" aria-label="Nueva terminal">+</button></div></div>
<div id="tabs" role="tablist" aria-label="Terminales"></div><div id="notice" role="status" hidden></div>
<section id="empty"><div class="empty-mark" aria-hidden="true">›_</div><h1>Tu terminal, a un lado.</h1><p>Sesiones independientes sin ocupar el editor ni el panel inferior.</p><button id="first" class="start-button">Nueva terminal</button><p class="empty-note">No hay shells en ejecución hasta que crees una sesión.</p></section>
<div id="terminals"></div><footer><span id="status">Listo</span><button id="settings" title="Configuración" aria-label="Abrir configuración">Ajustes</button></footer></main>
<script nonce="${nonce}" type="module" src="${resource('main.js')}"></script></body></html>`;
  }
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.sessions.forEach(s => clearTimeout(s.readyTimer));
    this.generation++;
    this.sessions.clear(); this.rendererReady = false;
    await this.clearDroppedFiles();
    await this.bridge.stop();
  }
  dispose(): void {
    void this.shutdown(); this.viewListeners.forEach(d => d.dispose()); this.listeners.forEach(d => d.dispose()); this.log.dispose();
  }
}

let provider: SideTermProvider | undefined;
export function activate(context: ExtensionContext): void {
  provider = new SideTermProvider(context);
  const instance = provider;
  context.subscriptions.push(instance, vscode.window.registerWebviewViewProvider(VIEW_ID, instance, {webviewOptions: {retainContextWhenHidden: true}}));
  const commands: Record<string, () => unknown> = {
    'sideterm.show': () => instance.show(), 'sideterm.focus': () => instance.focusTerminal(), 'sideterm.new': () => instance.newSession(),
    'sideterm.rename': () => instance.rename(), 'sideterm.resetName': () => instance.resetName(), 'sideterm.close': () => instance.closeSession(),
    'sideterm.closeAll': () => instance.endAll(), 'sideterm.copy': () => instance.copy(),
    'sideterm.paste': () => instance.paste(), 'sideterm.clear': () => instance.clear(),
    'sideterm.diagnostics': () => instance.diagnostics(), 'sideterm.settings': () => instance.settings()
  };
  for (const [command, action] of Object.entries(commands)) context.subscriptions.push(vscode.commands.registerCommand(command, action));
  const report = (error: unknown) => instance.report(error);
  context.subscriptions.push(vscode.commands.registerCommand('sideterm.insertPath', (clicked?: unknown, selected?: unknown) => {
    const uris = (Array.isArray(selected) && selected.length ? selected : clicked ? [clicked] : []) as Uri[];
    return instance.insertPaths(uris.map(uri => ({kind: 'uri', value: uri.toString()}))).catch(report);
  }));
  const dropHint = 'drop-hint';
  context.subscriptions.push(vscode.window.createTreeView<string>(DROP_VIEW_ID, {
    treeDataProvider: {
      getChildren: element => element ? [] : [dropHint],
      getTreeItem: () => ({label: 'Suelta aquí archivos del Explorador', iconPath: new vscode.ThemeIcon('cloud-upload'),
        tooltip: 'Inserta las rutas entre comillas en la pestaña activa de SideTerm, sin pulsar Enter.'})
    },
    dragAndDropController: {dropMimeTypes: ['text/uri-list'], dragMimeTypes: [],
      handleDrop: (_target, dataTransfer) => instance.onNativeDrop(dataTransfer).catch(report)}
  }));
}
export async function deactivate(): Promise<void> { await provider?.shutdown(); }
