const MAX_TEXT = 512 * 1024;
const MAX_FILES = 16;
const MAX_FILE = 20 * 1024 * 1024;
const MAX_TOTAL = 40 * 1024 * 1024;
const requestKey = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
function asRef(raw) {
    if (typeof raw === 'string') {
        if (!raw || raw.length > 32768 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(raw))
            return;
        if (/^(file|vscode-remote):/i.test(raw))
            return { kind: 'uri', value: raw };
        if (/^(\/|\\\\|[a-z]:[\\/])/i.test(raw))
            return { kind: 'path', value: raw };
    }
    else if (raw && typeof raw === 'object') {
        const u = raw;
        if ((u.scheme === 'file' || u.scheme === 'vscode-remote') && typeof u.path === 'string' && u.path.startsWith('/') &&
            (u.authority === undefined || typeof u.authority === 'string')) {
            const authority = String(u.authority || '');
            if (/[\s/?#@]/.test(authority))
                return;
            return asRef(`${u.scheme}://${authority}${u.path.split('/').map(encodeURIComponent).join('/')}`);
        }
    }
}
function parseRows(value, json, editors = false) {
    let raw;
    if (json) {
        const data = JSON.parse(value);
        if (!Array.isArray(data))
            throw new Error('Formato de arrastre no reconocido.');
        raw = data.map(item => editors ? item?.resource : item);
    }
    else
        raw = value.split(/\r?\n/).filter(line => line && !line.startsWith('#'));
    if (!raw.length || raw.length > MAX_FILES)
        throw new Error('Arrastra de 1 a 16 archivos o carpetas.');
    const refs = raw.map(asRef);
    if (refs.some(ref => !ref))
        throw new Error('El arrastre no contiene rutas válidas. No se usará el archivo abierto.');
    return refs;
}
export function extractDrop(data) {
    const read = (name) => {
        const type = [...data.types].find(t => t.toLowerCase() === name.toLowerCase());
        if (!type)
            return '';
        const value = data.getData(type);
        if (value.length > MAX_TEXT)
            throw new Error('Los metadatos del arrastre son demasiado grandes.');
        return value;
    };
    // Select one source of truth; do not combine MIME variants of the same drag.
    // The internal URI list is complete where Chromium's public URI list has one item.
    for (const [type, json, editors] of [
        ['application/vnd.code.uri-list', false, false], ['ResourceURLs', true, false],
        ['CodeFiles', true, false], ['text/uri-list', false, false], ['CodeEditors', true, true]
    ]) {
        const value = read(type);
        if (value)
            return { refs: parseRows(value, json, editors), files: [] };
    }
    const files = Array.from(data.files);
    if (files.length) {
        if (files.length > MAX_FILES)
            throw new Error('Máximo 16 archivos por arrastre.');
        const paths = files.map(file => asRef(file.path));
        if (paths.every(Boolean))
            return { refs: paths, files: [] };
        // Webviews normally expose bytes and names, not absolute OS paths.
        // Never infer a path from a filename or the currently open editor.
        if (files.some(file => file.size > MAX_FILE) || files.reduce((n, f) => n + f.size, 0) > MAX_TOTAL)
            throw new Error('La copia temporal admite 20 MiB por archivo y 40 MiB por arrastre. Para archivos mayores usa su ruta desde WSL.');
        return { refs: [], files };
    }
    const text = read('text/plain');
    if (text)
        return { refs: parseRows(text, false), files: [] };
    throw new Error('No se recibió una ruta ni un archivo. No se insertó el archivo abierto ni se leyó el portapapeles.');
}
export function installFileDrop(options) {
    let busy = false, depth = 0;
    const pending = new Map();
    const overlay = document.createElement('div');
    overlay.id = 'file-drop-hint';
    overlay.hidden = true;
    overlay.setAttribute('aria-hidden', 'true');
    document.getElementById('app').append(overlay);
    function request(id, action, fields = {}) {
        const requestId = requestKey();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('La transferencia no respondió. No vuelvas a arrastrar hasta comprobar el aviso.')); }, action === 'begin' ? 600000 : 30000);
            pending.set(requestId, { resolve, reject, timer });
            options.send({ type: 'fileDrop', id, requestId, action, ...fields });
        });
    }
    function reset() { depth = 0; overlay.hidden = true; }
    function relevant(event) {
        return !!event.dataTransfer && [...event.dataTransfer.types].some(t => ['files', 'resourceurls', 'codefiles', 'codeeditors', 'application/vnd.code.uri-list', 'text/uri-list', 'text/plain'].includes(t.toLowerCase()));
    }
    function intercept(event) { event.preventDefault(); event.stopImmediatePropagation(); }
    // Capture inside the iframe before VS Code's bubbling drag handlers. This avoids
    // handing the same file to both the terminal and the workbench editor drop zone.
    document.addEventListener('dragenter', event => {
        if (!relevant(event))
            return;
        intercept(event);
        depth++;
        const target = options.target();
        overlay.textContent = busy ? 'Transferencia en curso…' : target ? `Insertar solo los archivos arrastrados en ${target.name}` : 'Abre una terminal antes de arrastrar archivos';
        overlay.hidden = false;
    }, true);
    document.addEventListener('dragover', event => {
        if (!relevant(event))
            return;
        intercept(event);
        event.dataTransfer.dropEffect = options.target() && !busy ? 'copy' : 'none';
    }, true);
    document.addEventListener('dragleave', event => { if (depth > 0) {
        intercept(event);
        if (--depth <= 0)
            reset();
    } }, true);
    document.addEventListener('dragend', reset, true);
    window.addEventListener('blur', reset);
    document.addEventListener('drop', event => {
        // Even an unsupported drop must not navigate away from this terminal.
        intercept(event);
        reset();
        const target = options.target();
        if (!target) {
            options.notice('Abre una terminal en ejecución antes de arrastrar archivos.', true);
            return;
        }
        if (busy) {
            options.notice('Espera a que termine la transferencia anterior.', true);
            return;
        }
        if (!event.dataTransfer)
            return;
        let payload;
        try {
            payload = extractDrop(event.dataTransfer); // Read DataTransfer synchronously during drop.
            // A known directory path is fine; an opaque directory File cannot be copied recursively.
            if (payload.files.length)
                for (const item of Array.from(event.dataTransfer.items)) {
                    if (item.kind === 'file' && item.webkitGetAsEntry?.()?.isDirectory)
                        throw new Error('Arrastra carpetas desde el Explorador de VS Code en WSL. No se copian árboles de carpetas del escritorio.');
                }
        }
        catch (error) {
            options.notice(error instanceof Error ? error.message : String(error), true);
            return;
        }
        busy = true;
        void (async () => {
            let uploadId;
            try {
                if (payload.refs.length) {
                    await request(target.id, 'paths', { refs: payload.refs });
                    return;
                }
                const begin = await request(target.id, 'begin', { files: payload.files.map(file => ({ name: file.name, size: file.size })) });
                if (begin.cancelled)
                    return;
                uploadId = begin.uploadId;
                const chunkBytes = Number(begin.chunkBytes);
                if (typeof uploadId !== 'string' || chunkBytes !== 65536)
                    throw new Error('Respuesta de transferencia inválida.');
                options.notice('Copiando únicamente los archivos arrastrados a una carpeta temporal privada en WSL/Linux…');
                for (const [index, file] of payload.files.entries()) {
                    for (let offset = 0; offset < file.size; offset += chunkBytes) {
                        const bytes = new Uint8Array(await file.slice(offset, offset + chunkBytes).arrayBuffer());
                        let binary = '';
                        for (let start = 0; start < bytes.length; start += 8192)
                            binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
                        await request(target.id, 'chunk', { uploadId, index, offset, data: btoa(binary) });
                    }
                }
                await request(target.id, 'finish', { uploadId });
                uploadId = undefined;
            }
            catch (error) {
                if (uploadId)
                    options.send({ type: 'fileDrop', id: target.id, requestId: requestKey(), action: 'cancel', uploadId });
                options.notice(error instanceof Error ? error.message : String(error), true);
            }
            finally {
                busy = false;
            }
        })();
    }, true);
    return { message(message) {
            if (message.type !== 'fileDropResult' || typeof message.requestId !== 'string')
                return false;
            const request = pending.get(message.requestId);
            if (!request)
                return true;
            clearTimeout(request.timer);
            pending.delete(message.requestId);
            if (message.ok === true)
                request.resolve(message);
            else
                request.reject(new Error(typeof message.error === 'string' ? message.error : 'No se pudo insertar el archivo.'));
            return true;
        } };
}
