# SideTerm Local 0.1.2

Terminales reales en pestañas en la barra lateral secundaria de VS Code. Mantiene la Terminal nativa abajo y los archivos en el editor. Extensión privada para **WSL/Linux**, no publicada en Marketplace.

## Nuevo: arrastrar archivos, sin contexto automático

Suelta archivos en la terminal para insertar **únicamente las rutas arrastradas**, entre comillas, sin pulsar Enter. Soporta múltiples archivos y rutas de WSL. Cuando un archivo del escritorio no expone su ruta, pide permiso para transferir **ese archivo** a una copia temporal privada en WSL, por bloques de 64 KiB.

No toma el archivo abierto, no escanea editores ni añade selecciones automáticamente. Las integraciones de contexto propias de OpenCode/Claude son independientes y no se modifican.

**Actualizar:** guarda y cierra las sesiones → `Extensions: Install from VSIX...` → instala `sideterm-local-0.1.2.vsix` en WSL. No restablezcas las vistas ni desinstales la versión anterior.

[Guía de instalación, arrastre y límites](docs/GUIA.md) · [Pruebas](docs/PRUEBAS.md)

## Funciones conservadas

Pestañas independientes, título de proceso y carpeta actual, alias manuales, ancho equitativo con mínimo configurable, selector de carpeta en workspaces múltiples, copiar/pegar texto, redimensionamiento, confirmación de cierre y diagnóstico bajo demanda. Un ayudante Python compartido y una webview, sin servidor de ejecución propio ni dependencias npm de producción.

## Requisitos

VS Code 1.85+, host de extensión WSL/Linux y Python 3.8+. Para instalar el VSIX no necesitas npm, pip, compiladores ni la extensión Python de VS Code. El shell se ejecuta con los permisos de tu usuario; no uses workspaces no confiables.

## Límites importantes

Las sesiones no sobreviven a cerrar/recargar VS Code. Ctrl+V pega texto, no imágenes del portapapeles. No integra toda la experiencia de tareas, depuración o enlaces de la Terminal nativa. No transfiere archivos a hosts SSH ni contenedores anidados. Copias temporales: 20 MiB/archivo, 40 MiB/arrastre, 128 MiB/sesión. Un cierre forzoso puede dejar restos temporales.

Se probó en Linux con PTYs reales y Chromium con API de VS Code simulada. No se instaló este VSIX en Windows/WSL real ni se validó con cuentas autenticadas de agentes. Las pruebas de arrastre son sintéticas; confirma el flujo en tu entorno antes de trabajo prolongado.

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
