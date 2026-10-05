import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface HostMessage {
  type: 'ready' | 'spawned' | 'data' | 'exit' | 'error' | 'pong' | 'metadata';
  id?: string; pid?: number; protocol?: number; python?: string;
  data?: string; bytes?: number; code?: number | null; signal?: number | null;
  message?: string; operation?: string;
  cwd?: string; title?: string; process?: string; foreground?: boolean; foregroundKey?: string;
}

/** One Python process shared by all tabs. StdIO only; no TCP ports or shell:true. */
export class PtyBridge extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private ready = false;
  private line = '';
  private stderr = '';
  pythonVersion = '';

  constructor(private readonly script: string, private readonly python: () => string) { super(); }
  get pid(): number | undefined { return this.child?.pid; }
  get online(): boolean { return this.ready; }

  async start(): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.ready) return;
    if (this.starting) return this.starting;
    this.starting = this.launch();
    try { await this.starting; } finally { this.starting = undefined; }
  }

  private launch(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.line = ''; this.stderr = ''; this.ready = false;
      const child = spawn(this.python(), ['-I', '-S', '-u', this.script], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        env: { ...process.env }, shell: false
      });
      this.child = child;
      let settled = false;
      const fail = (error: Error) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(error); }
      };
      const timer = setTimeout(() => {
        fail(new Error('Python no respondió a tiempo. Revisa sideterm.pythonPath en la configuración remota.'));
        child.kill('SIGTERM');
      }, 6000);
      timer.unref();
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (text: string) => { this.stderr = (this.stderr + text).slice(-4096); });
      child.stdin.on('error', () => { /* exit event reports a closed pipe once */ });
      child.stdout.on('data', (text: string) => {
        this.line += text;
        if (this.line.length > 2 * 1024 * 1024) {
          fail(new Error('Respuesta del motor PTY demasiado grande.'));
          child.kill('SIGTERM'); return;
        }
        for (let index; (index = this.line.indexOf('\n')) !== -1;) {
          const row = this.line.slice(0, index); this.line = this.line.slice(index + 1);
          let message: HostMessage;
          try { message = JSON.parse(row) as HostMessage; }
          catch { child.kill('SIGTERM'); fail(new Error('Protocolo PTY inválido.')); return; }
          if (message.type === 'ready') {
            if (message.protocol !== 1) { fail(new Error('Versión del motor PTY incompatible.')); child.kill(); return; }
            this.ready = true; this.pythonVersion = message.python ?? '';
            if (!settled) { settled = true; clearTimeout(timer); resolve(); }
          } else { this.emit('message', message); }
        }
      });
      child.on('error', (err) => {
        fail(new Error(`No se pudo iniciar Python 3: ${err.message}. Configura sideterm.pythonPath en WSL.`));
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        const expected = !!this.stopping;
        if (this.child === child) { this.ready = false; this.child = undefined; }
        fail(new Error(`El motor PTY finalizó (${signal ?? code ?? 'desconocido'}). ${this.stderr}`.trim()));
        this.emit('stopped', { expected, code, signal });
      });
    });
  }

  send(message: unknown): boolean {
    const input = this.child?.stdin;
    if (!this.ready || !input || input.destroyed || input.writableLength > 1024 * 1024) return false;
    input.write(JSON.stringify(message) + '\n');
    return true;
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const child = this.child;
    if (!child) return Promise.resolve();
    this.stopping = new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 1800);
      timer.unref();
      child.once('close', () => { clearTimeout(timer); resolve(); });
      if (this.ready) this.send({ type: 'shutdown' });
      child.stdin.end();
    });
    return this.stopping.finally(() => { this.stopping = undefined; });
  }
}
