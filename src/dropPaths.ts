/** Resolve only paths explicitly delivered by a drop. Never consult an editor. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {execFile} from 'node:child_process';

export interface DroppedRef { kind: 'path' | 'uri'; value: string; }
export const MAX_DROP_FILES = 16;
const MAX_PATH = 32768;
const controls = /[\p{Cc}\p{Cf}\p{Cs}]/u;
export function validatePathText(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > MAX_PATH || controls.test(value))
    throw new Error('Ruta inválida: vacía, demasiado larga o con caracteres de control. No se insertó ningún archivo.');
}
export function quoteShellPath(value: string): string {
  validatePathText(value);
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
export interface PathEnvironment {
  wsl: boolean;
  distro?: string;
  authorities: string[];
  convertWindows?: (value: string) => Promise<string>;
  check?: (value: string) => Promise<void>;
}
function decoded(value: string): string {
  try { return decodeURIComponent(value); } catch { throw new Error('La ruta contiene una codificación URI inválida.'); }
}
function localAuthority(authority: string, env: PathEnvironment): boolean {
  const a = decoded(authority).toLowerCase();
  return env.authorities.some(item => decoded(item).toLowerCase() === a) ||
    (!!env.distro && a === `wsl+${env.distro}`.toLowerCase());
}
async function windowsPath(value: string, env: PathEnvironment): Promise<string> {
  const unc = /^(?:\\\\|\/\/)(wsl\$|wsl\.localhost)[\\/]([^\\/]+)([\\/].*)?$/i.exec(value);
  if (unc) {
    if (!env.wsl || !localAuthority(`wsl+${unc[2]}`, env))
      throw new Error('El archivo pertenece a otra distribución WSL. No se sustituyó por un archivo local.');
    return (unc[3] || '/').replace(/\\/g, '/');
  }
  if (!env.wsl) throw new Error('Esta ruta es de Windows, pero la sesión no se ejecuta en WSL.');
  if (!/^[a-z]:[\\/]/i.test(value))
    throw new Error('Ruta de red Windows no compatible. Arrastra el archivo desde el Explorador de VS Code en WSL.');
  if (env.convertWindows) return env.convertWindows(value);
  return new Promise((resolve, reject) => {
    // No shell, no command interpolation; use WSL itself, not a hardcoded /mnt/c.
    execFile('/usr/bin/wslpath', ['-u', value], {timeout: 3000, maxBuffer: 65536, windowsHide: true}, (error, stdout) => {
      if (error) reject(new Error('WSL no pudo convertir la ruta de Windows. Comprueba que la unidad está montada.'));
      else resolve(stdout.replace(/\r?\n$/, ''));
    });
  });
}
export async function resolveDropPaths(refs: unknown, env: PathEnvironment): Promise<string[]> {
  if (!Array.isArray(refs) || refs.length < 1 || refs.length > MAX_DROP_FILES)
    throw new Error(`Arrastra entre 1 y ${MAX_DROP_FILES} archivos o carpetas por operación.`);
  const result: string[] = [];
  for (const item of refs) {
    if (!item || typeof item !== 'object' || !['uri', 'path'].includes(item.kind)) throw new Error('Datos de arrastre no válidos.');
    validatePathText(item.value);
    let value: string = item.value;
    if (item.kind === 'uri') {
      let uri: URL;
      try { uri = new URL(value); } catch { throw new Error('No se pudo interpretar la URI arrastrada.'); }
      if (uri.username || uri.password || uri.port) throw new Error('La URI del archivo no es compatible.');
      const p = decoded(uri.pathname);
      if (uri.protocol === 'vscode-remote:') {
        if (!localAuthority(uri.hostname, env)) throw new Error('El archivo pertenece a otro host remoto. No se usó el editor activo.');
        value = p;
      } else if (uri.protocol === 'file:') {
        value = uri.hostname && uri.hostname !== 'localhost' ? `//${decoded(uri.hostname)}${p}` : p;
        if (/^\/[a-z]:\//i.test(value)) value = value.slice(1);
      } else throw new Error('Solo se admiten archivos locales o del mismo host WSL; no enlaces web ni archivos sin guardar.');
    }
    if (/^[a-z]:[\\/]/i.test(value) || /^(?:\\\\|\/\/)/.test(value)) value = await windowsPath(value, env);
    validatePathText(value);
    if (!path.posix.isAbsolute(value)) throw new Error('El arrastre no incluye una ruta absoluta. No se intentó adivinar un archivo.');
    value = path.posix.normalize(value);
    if (env.check) await env.check(value);
    else {
      try {
        const stat = await fs.promises.stat(value);
        if (!stat.isFile() && !stat.isDirectory()) throw new Error('not a regular file or directory');
        await fs.promises.access(value, stat.isDirectory() ? fs.constants.X_OK : fs.constants.R_OK);
      } catch { throw new Error('Una ruta arrastrada no existe o no es accesible desde esta sesión WSL/Linux. No se insertó ningún archivo.'); }
    }
    if (!result.includes(value)) result.push(value);
  }
  return result;
}
