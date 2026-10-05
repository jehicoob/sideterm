/** Bounded, opt-in transfer of OS File objects that expose no original path.
 * Each drop receives a private directory; bytes arrive in acknowledged chunks.
 * There is no watcher, HTTP server, editor access or background file discovery.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {randomUUID} from 'node:crypto';
import {MAX_DROP_FILES} from './dropPaths';
export const CHUNK_BYTES = 65536;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_BATCH_BYTES = 40 * 1024 * 1024;
const MAX_SESSION_BYTES = 128 * 1024 * 1024;
export interface DropFileMeta {name: string; size: number;}
export function validateDropFiles(raw: unknown): DropFileMeta[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_DROP_FILES) throw new Error('Número de archivos no válido (máximo 16).');
  const files = raw.map(f => {
    if (!f || typeof f !== 'object' || typeof f.name !== 'string' || !f.name || ['.', '..'].includes(f.name) ||
        /[\\/\p{Cc}\p{Cf}\p{Cs}]/u.test(f.name) || Buffer.byteLength(f.name) > 200 ||
        !Number.isSafeInteger(f.size) || f.size < 0 || f.size > MAX_FILE_BYTES)
      throw new Error('El archivo no se puede copiar: nombre inválido o tamaño superior a 20 MiB.');
    return {name: f.name, size: f.size};
  });
  if (files.reduce((n, f) => n + f.size, 0) > MAX_BATCH_BYTES) throw new Error('Las copias de un arrastre no pueden superar 40 MiB.');
  return files;
}
interface Upload {id: string; session: string; directory: string; files: DropFileMeta[]; paths: string[]; index: number; offset: number; busy: boolean; timer: NodeJS.Timeout; total: number;}
export class DropStore {
  private upload?: Upload;
  private owned = new Map<string, Array<{directory: string; total: number}>>();
  async begin(session: string, raw: unknown): Promise<{uploadId: string; chunkBytes: number}> {
    if (this.upload) throw new Error('Ya hay una transferencia en curso.');
    const files = validateDropFiles(raw), total = files.reduce((n,f) => n+f.size,0);
    if ((this.owned.get(session) || []).reduce((n,f)=>n+f.total,0) + total > MAX_SESSION_BYTES)
      throw new Error('Esta sesión alcanzaría 128 MiB en copias temporales. Usa una ruta accesible directamente.');
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sideterm-drop-'));
    await fs.promises.chmod(directory, 0o700);
    const paths: string[] = [];
    try {
      // Prefixing avoids collisions, including case-folded names on unusual mounts.
      for (const [index, file] of files.entries()) {
        const p = path.join(directory, `${index+1}-${file.name}`);
        await fs.promises.writeFile(p, '', {flag: 'wx', mode: 0o600}); paths.push(p);
      }
    } catch (error) { await fs.promises.rm(directory, {recursive: true, force: true}); throw error; }
    const id = randomUUID();
    const timer = setTimeout(() => { void this.cancel(id); }, 60000); timer.unref();
    this.upload = {id, session, directory, files, paths, index: 0, offset: 0, busy: false, timer, total};
    return {uploadId: id, chunkBytes: CHUNK_BYTES};
  }
  private active(session: string, id: unknown): Upload {
    if (!this.upload || this.upload.id !== id || this.upload.session !== session) throw new Error('Transferencia caducada o de otra sesión.');
    this.upload.timer.refresh(); return this.upload;
  }
  async chunk(session: string, id: unknown, index: unknown, offset: unknown, base64: unknown): Promise<void> {
    const u = this.active(session, id);
    if (u.busy) throw new Error('Espera la confirmación del bloque anterior.');
    // Empty files have no chunks.
    while (u.index < u.files.length && u.files[u.index].size === 0) u.index++;
    if (index !== u.index || offset !== u.offset || u.index >= u.files.length || typeof base64 !== 'string' ||
        base64.length > Math.ceil(CHUNK_BYTES/3)*4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('Bloque de archivo inválido.');
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length || bytes.length > CHUNK_BYTES || bytes.toString('base64') !== base64 || u.offset+bytes.length > u.files[u.index].size)
      throw new Error('Tamaño o codificación de bloque inválido.');
    u.busy = true;
    try {
      // O_NOFOLLOW prevents a same-user process replacing the target with a symlink.
      const handle = await fs.promises.open(u.paths[u.index], fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
      try {
        let done = 0;
        while (done < bytes.length) {
          const written = await handle.write(bytes, done, bytes.length-done, u.offset+done);
          if (!written.bytesWritten) throw new Error('No se pudo escribir el bloque completo.');
          done += written.bytesWritten;
        }
      } finally { await handle.close(); }
      u.offset += bytes.length;
      if (u.offset === u.files[u.index].size) {u.index++; u.offset=0;}
    } finally {u.busy = false;}
  }
  async finish(session: string, id: unknown): Promise<string[]> {
    const u = this.active(session,id);
    while (u.index < u.files.length && u.files[u.index].size === 0) u.index++;
    if (u.busy || u.index !== u.files.length) throw new Error('La transferencia aún no está completa.');
    clearTimeout(u.timer); this.upload = undefined;
    const list = this.owned.get(session) || []; list.push({directory:u.directory,total:u.total}); this.owned.set(session,list);
    return u.paths;
  }
  async cancel(id?: unknown): Promise<void> {
    const u = this.upload;
    if (!u || (id !== undefined && id !== u.id)) return;
    clearTimeout(u.timer); this.upload=undefined;
    await fs.promises.rm(u.directory,{recursive:true,force:true});
  }
  async clearSession(session: string): Promise<void> {
    if (this.upload?.session === session) await this.cancel();
    const list=this.owned.get(session) || []; this.owned.delete(session);
    await Promise.all(list.map(f=>fs.promises.rm(f.directory,{recursive:true,force:true})));
  }
  async dispose(): Promise<void> {
    await this.cancel();
    await Promise.all([...this.owned.keys()].map(id=>this.clearSession(id)));
  }
}
