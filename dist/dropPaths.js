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
exports.MAX_DROP_FILES = void 0;
exports.validatePathText = validatePathText;
exports.quoteShellPath = quoteShellPath;
exports.resolveDropPaths = resolveDropPaths;
/** Resolve only paths explicitly delivered by a drop. Never consult an editor. */
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
exports.MAX_DROP_FILES = 16;
const MAX_PATH = 32768;
const controls = /[\p{Cc}\p{Cf}\p{Cs}]/u;
function validatePathText(value) {
    if (typeof value !== 'string' || !value || value.length > MAX_PATH || controls.test(value))
        throw new Error('Ruta inválida: vacía, demasiado larga o con caracteres de control. No se insertó ningún archivo.');
}
function quoteShellPath(value) {
    validatePathText(value);
    return "'" + value.replace(/'/g, "'\\''") + "'";
}
function decoded(value) {
    try {
        return decodeURIComponent(value);
    }
    catch {
        throw new Error('La ruta contiene una codificación URI inválida.');
    }
}
function localAuthority(authority, env) {
    const a = decoded(authority).toLowerCase();
    return env.authorities.some(item => decoded(item).toLowerCase() === a) ||
        (!!env.distro && a === `wsl+${env.distro}`.toLowerCase());
}
async function windowsPath(value, env) {
    const unc = /^(?:\\\\|\/\/)(wsl\$|wsl\.localhost)[\\/]([^\\/]+)([\\/].*)?$/i.exec(value);
    if (unc) {
        if (!env.wsl || !localAuthority(`wsl+${unc[2]}`, env))
            throw new Error('El archivo pertenece a otra distribución WSL. No se sustituyó por un archivo local.');
        return (unc[3] || '/').replace(/\\/g, '/');
    }
    if (!env.wsl)
        throw new Error('Esta ruta es de Windows, pero la sesión no se ejecuta en WSL.');
    if (!/^[a-z]:[\\/]/i.test(value))
        throw new Error('Ruta de red Windows no compatible. Arrastra el archivo desde el Explorador de VS Code en WSL.');
    if (env.convertWindows)
        return env.convertWindows(value);
    return new Promise((resolve, reject) => {
        // No shell, no command interpolation; use WSL itself, not a hardcoded /mnt/c.
        (0, node_child_process_1.execFile)('/usr/bin/wslpath', ['-u', value], { timeout: 3000, maxBuffer: 65536, windowsHide: true }, (error, stdout) => {
            if (error)
                reject(new Error('WSL no pudo convertir la ruta de Windows. Comprueba que la unidad está montada.'));
            else
                resolve(stdout.replace(/\r?\n$/, ''));
        });
    });
}
async function resolveDropPaths(refs, env) {
    if (!Array.isArray(refs) || refs.length < 1 || refs.length > exports.MAX_DROP_FILES)
        throw new Error(`Arrastra entre 1 y ${exports.MAX_DROP_FILES} archivos o carpetas por operación.`);
    const result = [];
    for (const item of refs) {
        if (!item || typeof item !== 'object' || !['uri', 'path'].includes(item.kind))
            throw new Error('Datos de arrastre no válidos.');
        validatePathText(item.value);
        let value = item.value;
        if (item.kind === 'uri') {
            let uri;
            try {
                uri = new URL(value);
            }
            catch {
                throw new Error('No se pudo interpretar la URI arrastrada.');
            }
            if (uri.username || uri.password || uri.port)
                throw new Error('La URI del archivo no es compatible.');
            const p = decoded(uri.pathname);
            if (uri.protocol === 'vscode-remote:') {
                if (!localAuthority(uri.hostname, env))
                    throw new Error('El archivo pertenece a otro host remoto. No se usó el editor activo.');
                value = p;
            }
            else if (uri.protocol === 'file:') {
                value = uri.hostname && uri.hostname !== 'localhost' ? `//${decoded(uri.hostname)}${p}` : p;
                if (/^\/[a-z]:\//i.test(value))
                    value = value.slice(1);
            }
            else if (uri.protocol === 'vscode-local:') {
                // A file on the VS Code client (Windows) seen from this WSL extension host.
                if (!env.wsl || uri.hostname || !/^\/[a-z]:\//i.test(p))
                    throw new Error('Este archivo del equipo Windows no tiene una ruta de unidad convertible a WSL.');
                value = p.slice(1);
            }
            else
                throw new Error(`Solo se admiten archivos de WSL/Linux o de unidades de Windows (se recibió «${uri.protocol}»); no enlaces web ni archivos sin guardar.`);
        }
        if (/^[a-z]:[\\/]/i.test(value) || /^(?:\\\\|\/\/)/.test(value))
            value = await windowsPath(value, env);
        validatePathText(value);
        if (!path.posix.isAbsolute(value))
            throw new Error('El arrastre no incluye una ruta absoluta. No se intentó adivinar un archivo.');
        value = path.posix.normalize(value);
        if (env.check)
            await env.check(value);
        else {
            try {
                const stat = await fs.promises.stat(value);
                if (!stat.isFile() && !stat.isDirectory())
                    throw new Error('not a regular file or directory');
                await fs.promises.access(value, stat.isDirectory() ? fs.constants.X_OK : fs.constants.R_OK);
            }
            catch {
                throw new Error('Una ruta arrastrada no existe o no es accesible desde esta sesión WSL/Linux. No se insertó ningún archivo.');
            }
        }
        if (!result.includes(value))
            result.push(value);
    }
    return result;
}
