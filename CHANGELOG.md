# Changelog

## 0.1.2 — Explicit file drag-and-drop

- Insert only paths explicitly supplied by the current drop, escaped for bash/zsh, without Enter.
- Accept full VS Code URI lists, file URIs and absolute Linux/Windows paths; verify local accessibility and same remote host.
- Convert Windows drive paths on demand through wslpath, without assuming a mount root.
- For opaque external File objects, require consent and stream only the dropped files to private temporary copies in 64 KiB acknowledged chunks.
- Bound copies to 20 MiB/file, 40 MiB/drop, 128 MiB/session and 16 items; clean owned temporary files on session/view disposal.
- No active editor, selection, clipboard or filename-based fallback; no changes to other extensions' auto-context settings.
- Preserve tab names, equal widths, session behavior, extension ID, view ID and layout.

# Cambios

## 0.1.1 — 2026-10-05

- Nombres automáticos basados en el programa de primer plano, conservando la carpeta.
- Directorio actualizado desde el proceso real, también después de `cd` y al regresar al shell.
- Identificación de OpenCode/Claude/Codex por ejecutable o punto de entrada; títulos OSC reconocidos como alternativa para runtimes genéricos.
- Los argumentos completos de los programas no se muestran ni se registran.
- Un único muestreo de metadatos cada segundo, suspendido con la vista oculta; sin nuevos procesos ni dependencias.
- Reparto igualitario de toda la fila de pestañas; mínimo configurable `sideterm.tabMinWidth` (140 px por defecto) y desplazamiento horizontal al desbordar.
- Nombre manual como alias con carpeta dinámica. Campo vacío o nuevo comando para restaurar el nombre automático.
- Pruebas ampliadas de PTY, metadatos, nombres, alias y anchuras; se mantienen los IDs de extensión, contenedor y vista.

## 0.1.0 — 2026-10-05

Primera versión local: vista lateral con varias sesiones PTY, xterm, selección
multi-root, copiar/pegar, confirmaciones, diagnóstico y control de flujo.
