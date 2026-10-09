# Changelog

## 0.1.5 — La barra de menús ya no roba el foco tras Alt+Tab

- Causa observada en VS Code 1.140.0 (Windows + WSL2): VS Code recibe las teclas reenviadas por la webview y enfoca su barra de menús tras pulsar y soltar Alt sin otra tecla. Con Alt+Tab, VS Code veía la pulsación de Alt desde SideTerm, pero la liberación ocurría en otra aplicación; al volver, la liberación de cualquier letra completaba ese gesto y el foco pasaba a `menubar-menu-button` (`onModifierKeyToggled`). Ahora la terminal no reenvía a VS Code las pulsaciones de Alt o AltGr sin otra tecla. Consecuencia: pulsar Alt solo dentro de SideTerm ya no lleva a la barra de menús; usa F10 o el ratón.
- Se retira la recuperación de foco de 0.1.4, basada en una hipótesis que el diagnóstico descartó: el cuadro de texto de xterm conservaba el foco.

## 0.1.4 — Comando de foco

- Nuevo comando **SideTerm: Enfocar terminal**, asignable a un atajo desde *Keyboard Shortcuts*.

## 0.1.3 — Soltar archivos desde el Explorador y última fila visible

- Nueva vista nativa **Soltar archivos** en el contenedor de SideTerm: acepta `text/uri-list` desde el Explorador de VS Code e inserta las rutas entre comillas en la pestaña activa, sin Enter. Evita el iframe de la webview, que no recibe esos eventos en VS Code 1.140.0 + WSL2.
- Nuevo comando **Insertar ruta en SideTerm** en el menú contextual del Explorador, con selección múltiple.
- Archivos de Windows: además de `file:///C:/...` y `C:\...`, se acepta la forma `vscode-local:/c:/...` que VS Code usa para archivos del equipo Windows en una ventana WSL. Se convierte con `wslpath` (por ejemplo, a `/mnt/c/...`) y se inserta la ruta del original, sin copiarlo. Si llega un esquema no admitido, el aviso lo nombra.
- Ambos reutilizan la validación de 0.1.2: mismo host remoto, rutas accesibles, máximo 16 elementos, sin editor activo ni portapapeles.
- Corregida la última fila de la terminal tapada por el pie: el espaciado del panel pasa de `padding` a desplazamientos, porque FitAddon medía la altura incluyendo el padding. Margen inferior de 10 px.

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
