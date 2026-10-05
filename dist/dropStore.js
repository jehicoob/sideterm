"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DropStore = exports.MAX_BATCH_BYTES = exports.MAX_FILE_BYTES = exports.CHUNK_BYTES = void 0;
exports.validateDropFiles = validateDropFiles;
/** Bounded, opt-in transfer of OS File objects that expose no original path.
 * Each drop receives a private directory; bytes arrive in acknowledged chunks.
 * There is no watcher, HTTP server, editor access or background file discovery.
 */
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const os = __importStar(require("node:os"));
const node_crypto_1 = require("node:crypto");
const dropPaths_1 = require("./dropPaths");
exports.CHUNK_BYTES = 65536;
exports.MAX_FILE_BYTES = 20 * 1024 * 1024;
exports.MAX_BATCH_BYTES = 40 * 1024 * 1024;
const MAX_SESSION_BYTES = 128 * 1024 * 1024;
function validateDropFiles(raw) {
    if (!Array.isArray(raw) || !raw.length || raw.length > dropPaths_1.MAX_DROP_FILES)
        throw new Error('Número de archivos no válido (máximo 16).');
    const files = raw.map(f => {
        if (!f || typeof f !== 'object' || typeof f.name !== 'string' || !f.name || ['.', '..'].includes(f.name) ||
            /[\\/\p{Cc}\p{Cf}\p{Cs}]/u.test(f.name) || Buffer.byteLength(f.name) > 200 ||
            !Number.isSafeInteger(f.size) || f.size < 0 || f.size > exports.MAX_FILE_BYTES)
            throw new Error('El archivo no se puede copiar: nombre inválido o tamaño superior a 20 MiB.');
        return { name: f.name, size: f.size };
    });
    if (files.reduce((n, f) => n + f.size, 0) > exports.MAX_BATCH_BYTES)
        throw new Error('Las copias de un arrastre no pueden superar 40 MiB.');
    return files;
}
class DropStore {
    upload;
    owned = new Map();
    async begin(session, raw) {
        if (this.upload)
            throw new Error('Ya hay una transferencia en curso.');
        const files = validateDropFiles(raw), total = files.reduce((n, f) => n + f.size, 0);
        if ((this.owned.get(session) || []).reduce((n, f) => n + f.total, 0) + total > MAX_SESSION_BYTES)
            throw new Error('Esta sesión alcanzaría 128 MiB en copias temporales. Usa una ruta accesible directamente.');
        const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sideterm-drop-'));
        await fs.promises.chmod(directory, 0o700);
        const paths = [];
        try {
            // Prefixing avoids collisions, including case-folded names on unusual mounts.
            for (const [index, file] of files.entries()) {
                const p = path.join(directory, `${index + 1}-${file.name}`);
                await fs.promises.writeFile(p, '', { flag: 'wx', mode: 0o600 });
                paths.push(p);
            }
        }
        catch (error) {
            await fs.promises.rm(directory, { recursive: true, force: true });
            throw error;
        }
        const id = (0, node_crypto_1.randomUUID)();
        const timer = setTimeout(() => { void this.cancel(id); }, 60000);
        timer.unref();
        this.upload = { id, session, directory, files, paths, index: 0, offset: 0, busy: false, timer, total };
        return { uploadId: id, chunkBytes: exports.CHUNK_BYTES };
    }
    active(session, id) {
        if (!this.upload || this.upload.id !== id || this.upload.session !== session)
            throw new Error('Transferencia caducada o de otra sesión.');
        this.upload.timer.refresh();
        return this.upload;
    }
    async chunk(session, id, index, offset, base64) {
        const u = this.active(session, id);
        if (u.busy)
            throw new Error('Espera la confirmación del bloque anterior.');
        // Empty files have no chunks.
        while (u.index < u.files.length && u.files[u.index].size === 0)
            u.index++;
        if (index !== u.index || offset !== u.offset || u.index >= u.files.length || typeof base64 !== 'string' ||
            base64.length > Math.ceil(exports.CHUNK_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64))
            throw new Error('Bloque de archivo inválido.');
        const bytes = Buffer.from(base64, 'base64');
        if (!bytes.length || bytes.length > exports.CHUNK_BYTES || bytes.toString('base64') !== base64 || u.offset + bytes.length > u.files[u.index].size)
            throw new Error('Tamaño o codificación de bloque inválido.');
        u.busy = true;
        try {
            // O_NOFOLLOW prevents a same-user process replacing the target with a symlink.
            const handle = await fs.promises.open(u.paths[u.index], fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
            try {
                let done = 0;
                while (done < bytes.length) {
                    const written = await handle.write(bytes, done, bytes.length - done, u.offset + done);
                    if (!written.bytesWritten)
                        throw new Error('No se pudo escribir el bloque completo.');
                    done += written.bytesWritten;
                }
            }
            finally {
                await handle.close();
            }
            u.offset += bytes.length;
            if (u.offset === u.files[u.index].size) {
                u.index++;
                u.offset = 0;
            }
        }
        finally {
            u.busy = false;
        }
    }
    async finish(session, id) {
        const u = this.active(session, id);
        while (u.index < u.files.length && u.files[u.index].size === 0)
            u.index++;
        if (u.busy || u.index !== u.files.length)
            throw new Error('La transferencia aún no está completa.');
        clearTimeout(u.timer);
        this.upload = undefined;
        const list = this.owned.get(session) || [];
        list.push({ directory: u.directory, total: u.total });
        this.owned.set(session, list);
        return u.paths;
    }
    async cancel(id) {
        const u = this.upload;
        if (!u || (id !== undefined && id !== u.id))
            return;
        clearTimeout(u.timer);
        this.upload = undefined;
        await fs.promises.rm(u.directory, { recursive: true, force: true });
    }
    async clearSession(session) {
        if (this.upload?.session === session)
            await this.cancel();
        const list = this.owned.get(session) || [];
        this.owned.delete(session);
        await Promise.all(list.map(f => fs.promises.rm(f.directory, { recursive: true, force: true })));
    }
    async dispose() {
        await this.cancel();
        await Promise.all([...this.owned.keys()].map(id => this.clearSession(id)));
    }
}
exports.DropStore = DropStore;
