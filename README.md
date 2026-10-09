# SideTerm Local 0.2.0

Terminales reales en pestañas en la barra lateral secundaria de VS Code. Mantiene la Terminal nativa abajo y los archivos en el editor. Extensión privada para **WSL2/Linux y macOS**, no publicada en Marketplace.

## Nuevo: arrastrar archivos, sin contexto automático

Cuando la webview recibe un archivo soltado, SideTerm inserta **únicamente su ruta**, entre comillas, sin pulsar Enter. Admite múltiples archivos y rutas de WSL. Si recibe un archivo del escritorio sin ruta, pide permiso para transferir **ese archivo** a una copia temporal privada en WSL, por bloques de 64 KiB. En VS Code 1.140.0 sobre Windows + WSL2, el arrastre desde el Explorador de VS Code no llega a la webview de la terminal. Desde 0.1.3, suelta esos archivos en la vista **Soltar archivos** del panel de SideTerm o usa **Insertar ruta en SideTerm** en el menú contextual del Explorador; consulta la [guía](docs/GUIA.md#arrastrar-desde-el-explorador-de-vs-code).

No toma el archivo abierto, no escanea editores ni añade selecciones automáticamente. Las integraciones de contexto propias de OpenCode/Claude son independientes y no se modifican.

**Actualizar:** guarda y cierra las sesiones → `Extensions: Install from VSIX...` → instala `sideterm-local-0.2.0.vsix` (en WSL, en la ventana remota; en macOS, en la ventana local). No restablezcas las vistas ni desinstales la versión anterior.

[Guía de instalación, arrastre y límites](docs/GUIA.md) · [Pruebas](docs/PRUEBAS.md)

## Funciones conservadas

Pestañas independientes, título de proceso y carpeta actual, alias manuales, ancho equitativo con mínimo configurable, selector de carpeta en workspaces múltiples, copiar/pegar texto, redimensionamiento, confirmación de cierre y diagnóstico bajo demanda. Un ayudante Python compartido y una webview, sin servidor de ejecución propio ni dependencias npm de producción.

## Requisitos

VS Code 1.85+, host de extensión WSL/Linux o macOS y Python 3.8+ (en macOS sirve el `python3` de las Command Line Tools o el de Homebrew). Para instalar el VSIX no necesitas npm, pip, compiladores ni la extensión Python de VS Code. El shell se ejecuta con los permisos de tu usuario; no uses workspaces no confiables.

## macOS (desde 0.2.0)

- Instala el VSIX en una ventana local de VS Code; las terminales se abren en el Mac. También funciona con Remote-SSH hacia un Mac.
- Sin `/proc`, el ayudante lee procesos con `libproc` (vía `ctypes`, solo biblioteca estándar): nombre de la pestaña, carpeta actual y detección de OpenCode/Claude/Codex.
- Si no cambias `sideterm.shellArgs`, el shell arranca como **login** (`-l -i`), como Terminal.app, para leer `.zprofile` (Homebrew, nvm…). Personalízalo y se respetará tal cual.
- Copiar/pegar: `Cmd+C` / `Cmd+V`. `Option` solo no se reenvía a VS Code (evita que la barra de menús robe el foco).
- No hay conversión de rutas de Windows: en macOS solo se aceptan archivos locales.

## Límites importantes

Las sesiones no sobreviven a cerrar/recargar VS Code. Ctrl+V pega texto, no imágenes del portapapeles. El arrastre desde el Explorador de VS Code directamente sobre la terminal no funciona en el entorno comprobado; usa la vista **Soltar archivos** o el menú contextual. No integra toda la experiencia de tareas, depuración o enlaces de la Terminal nativa. No transfiere archivos a hosts SSH ni contenedores anidados. Copias temporales: 20 MiB/archivo, 40 MiB/arrastre, 128 MiB/sesión. Un cierre forzoso puede dejar restos temporales.

Se probó en Linux con PTYs reales y Chromium con API de VS Code simulada. La grabación y las herramientas de desarrollo en VS Code/Windows/WSL2 permitieron observar la limitación del arrastre desde el Explorador; no se validó la transferencia desde el escritorio Windows ni con cuentas autenticadas de agentes. Las pruebas automatizadas de arrastre son sintéticas.

## Desarrollo

```bash
npm install
npm run build
npm test
python3 scripts/package.py --out-dir /ruta/de/salida
```

El código fuente contiene tests, un emulador de las API públicas de VS Code y una prueba opcional de Chromium. No forman parte del instalable. El componente terminal utiliza xterm.js y su addon de ajuste; consulta `THIRD_PARTY_NOTICES.md` para licencias.

## Ajustes principales

`sideterm.tabMinWidth` (140 px), `sideterm.scrollback` (1.000 líneas), `sideterm.maxSessions` (6), `sideterm.cursorBlink` (false), `sideterm.shell`, `sideterm.shellArgs`, `sideterm.pythonPath`, `sideterm.fontSize`, `sideterm.confirmClose`, `sideterm.confirmMultilinePaste`.
