# SideTerm Local 0.1.2 — Arrastre explícito de archivos

## Actualizar sin cambiar la distribución

1. Guarda el trabajo y cierra las sesiones de SideTerm. Todavía no sobreviven a una recarga.
2. En tu ventana **WSL: Ubuntu-22.04**, usa `Ctrl+Shift+P` → `Extensions: Install from VSIX...`.
3. Selecciona **sideterm-local-0.1.2.vsix**. No desinstales antes la versión anterior.
4. Recarga solo si VS Code lo solicita. Confirma **0.1.2** en la instalación WSL.
5. Abre SideTerm en su ubicación actual y crea sesiones nuevas.

No ejecutes `View: Reset View Locations`, no muevas la Terminal nativa y no vuelvas a dividir el editor. Se conservan el identificador `jehicoob-local.sideterm-local`, la vista y los ajustes existentes.

## Qué se corrigió

En 0.1.1 faltaban los manejadores de arrastre. Esta versión agrega una ruta explícita **si el evento llega a SideTerm**:

**Archivo soltado → datos del arrastre → ruta accesible en WSL/Linux → texto entre comillas → terminal de destino.**

No lee el archivo que tienes abierto, la selección del editor, otros editores visibles ni el portapapeles para resolver un arrastre. Si la información recibida no permite identificar el archivo, muestra un aviso: no busca uno con el mismo nombre ni sustituye por el editor activo.

La ruta se inserta como texto, con comillas y escape de apóstrofes para bash/zsh. No se pulsa Enter ni se añade un salto de línea. El programa que ejecutes decide cómo interpretar esa ruta. Esto no es una API de adjuntos propia de Claude/OpenCode: se comporta como la inserción de rutas de una terminal.

## Arrastrar desde el Explorador de VS Code

**Limitación observada:** en VS Code 1.140.0 instalado en Windows con workspace WSL2, al arrastrar un archivo desde el Explorador de VS Code hacia SideTerm, la webview no recibe `dragenter`, `dragover` ni `drop`. Se confirmó en las herramientas de desarrollo dentro de SideTerm; al arrastrar hacia la vista independiente de OpenCode sí se reciben eventos. VS Code desactiva temporalmente los eventos de puntero del iframe de la webview durante arrastres iniciados en la ventana ([código de VS Code 1.140.0](https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/contrib/webview/browser/webviewElement.ts)). Por ello, los manejadores de SideTerm no pueden insertar esa ruta en este caso; pulsar Shift no cambia el resultado. No se ha comprobado este comportamiento con archivos arrastrados desde el escritorio Windows ni en todas las versiones de VS Code.

Como alternativa para un archivo del proyecto, escribe o pega manualmente su ruta accesible desde WSL en la terminal. El arrastre directo desde el Explorador de VS Code queda pendiente de una solución que no dependa del evento `drop` de esta webview.

Cuando se recibe un evento de arrastre válido con varias selecciones, se insertan varias rutas, separadas por espacios, sin combinar los distintos formatos duplicados del mismo evento. Máximo: **16 archivos o carpetas por arrastre**.

Ejemplo de texto insertado:

```text
'/home/usuario/projects/app/captura.png' '/home/usuario/projects/app/README.md'
```

Un archivo abierto distinto no participa. Los cambios sin guardar del editor tampoco se exportan: una referencia apunta a la versión existente en disco. Guarda un archivo antes de esperar que el agente lea sus últimas modificaciones.

## Arrastrar desde Windows

Hay dos casos:

| Lo que entrega Windows/VS Code | Comportamiento |
|---|---|
| Una ruta absoluta o URI accesible | Se convierte al formato WSL cuando hace falta, se comprueba su existencia y se inserta la ruta del original. |
| Un objeto de archivo con nombre y bytes, pero sin ruta original | Se pide permiso para copiar **solo lo arrastrado** a una carpeta temporal privada de WSL/Linux. Se inserta la ruta de la copia. Cancelar no inserta nada. |

Si un arrastre externo llega a SideTerm, la conversión de unidades Windows invoca `wslpath -u` con argumentos separados, sin un shell y sin asumir que todas las instalaciones montan C: en `/mnt/c`. Las rutas `\\wsl.localhost\<distro>\...` y `\\wsl$\<distro>\...` solo se convierten directamente cuando pertenecen a la distribución actual. Se rechazan otros hosts remotos en lugar de reinterpretarlos como locales.

**Las copias temporales no son los originales.** Si un agente edita una copia, no modifica el archivo original de Windows. Se muestra un aviso indicando que son copias. Esta alternativa puede servir para imágenes y documentos que solo quieres mostrar al agente, si el arrastre externo llega a SideTerm. Para editar el original, usa una ruta accesible desde WSL.

Límites de la copia: **20 MiB por archivo**, **40 MiB por arrastre** y **128 MiB de copias por sesión**. La referencia a un original no tiene ese límite de tamaño, porque no se lee su contenido al arrastrarlo. No se copian carpetas del escritorio de forma recursiva. No se descargan enlaces web ni se extraen ZIP.

Las copias viven en una carpeta aleatoria con prefijo `/tmp/sideterm-drop-` (o el directorio temporal del sistema), con permiso 0700; los archivos se crean con permiso 0600. Se eliminan al cerrar la pestaña, cerrar todas las sesiones, recargar normalmente la vista o desactivar la extensión. Un cierre forzoso del proceso o del equipo puede dejar restos temporales. No es borrado seguro criptográfico ni un sistema persistente de almacenamiento.

## Sobre el archivo abierto que aparece como contexto en un agente

**SideTerm 0.1.1 no incluía una función para adjuntar el editor activo. 0.1.2 tampoco la incluye.** La actualización agrega el arrastre; no afirma desactivar las integraciones de otras extensiones.

OpenCode documenta una integración de IDE que comparte automáticamente la selección o pestaña actual. Claude Code también dispone de contexto del editor mediante su propia integración. Es una posible causa de lo que observas, no una identificación confirmada en tu equipo.

En Claude Code, las versiones que ofrecen **Attach Open File** permiten desactivarlo en ajustes de VS Code:

```json
"claudeCode.attachOpenFile": false
```

No reemplaces el resto de `settings.json`. Según su documentación, esto no desactiva el envío de texto seleccionado. Es una opción de Claude, no de SideTerm, y esta extensión no la modifica por su cuenta.

Para aislar la integración de OpenCode sin desinstalar el CLI, puedes deshabilitar **su extensión de VS Code para el workspace** desde Extensiones → OpenCode → engranaje → Disable (Workspace), guardando primero tu trabajo antes de cualquier recarga. Esto desactiva también sus funciones de integración con el IDE. No equivale a bloquear los archivos que el propio agente decida leer o sus instrucciones `AGENTS.md`.

## Prueba inicial recomendada en tu WSL

1. Abre una terminal nueva y ejecuta `pwd`.
2. Para referenciar un archivo del proyecto, escribe o pega su ruta accesible desde WSL. El arrastre desde el Explorador de VS Code no funciona en el entorno descrito arriba.
3. Si quieres investigar el arrastre desde el escritorio Windows, pruébalo por separado: todavía no se ha validado en VS Code/WSL2. Si la webview recibe un objeto con bytes pero sin ruta, SideTerm pedirá confirmar una copia temporal; cancelar no inserta nada.
4. Cuando una ruta llegue a la terminal, el agente y el modelo determinarán cómo interpretar el archivo, incluida una imagen. La ruta no es un adjunto propio del agente.

La transferencia conserva como destino la pestaña activa **en el momento de soltar**. Si cambias de pestaña mientras confirmas o se copia el archivo, no se redirige a la nueva. Si cierras la pestaña de destino, no se busca otra terminal.

## Rendimiento

No se añade ningún proceso residente, servidor HTTP, sondeo ni lector del editor. Para las rutas del proyecto solo se consultan metadatos del archivo. `wslpath` se invoca únicamente cuando hay una ruta de unidad Windows que convertir. Las copias se leen y escriben en bloques de **64 KiB**, esperando confirmación por cada bloque antes de enviar el siguiente; no se carga un archivo entero en memoria.

Se mantienen el ayudante Python compartido, la consulta de nombres/rutas de 0.1.1, las pestañas equitativas y los límites de historial existentes. El agente que ejecutes tiene su propio consumo, independiente de SideTerm.

## Límites pendientes relevantes

- **Imágenes del portapapeles:** Ctrl+V sigue siendo pegado de texto. Arrastrar una imagen no es lo mismo que pegar una captura desde el portapapeles.
- **Persistencia:** cerrar/recargar VS Code o destruir la vista termina las sesiones. No hay reconexión a procesos persistentes.
- **Enlaces de la salida:** no se añadió apertura automática de URLs ni de rutas con clic. Se conserva el bloqueo de navegación automática y de acceso OSC 52 al portapapeles.
- **Integración nativa completa:** no se heredan todas las funciones de tareas, depuración, shell integration ni perfiles especiales de la Terminal nativa.
- **SSH, Docker, tmux y otros entornos anidados:** una ruta accesible en WSL no necesariamente existe dentro del host remoto o contenedor. No se transfieren automáticamente archivos a esos entornos.
- **Plataformas:** esta versión sigue siendo WSL/Linux; no habilita Windows nativo ni macOS.

No se promete paridad total con la terminal nativa. Las funciones nuevas se probaron con archivos y PTY reales en Linux y eventos de arrastre sintéticos en Chromium. La observación en VS Code/Windows/WSL2 confirmó que el arrastre desde el Explorador **no llega a SideTerm**; no se probó un arrastre nativo del escritorio Windows. Ver `PRUEBAS.md`.

## Referencias consultadas

- VS Code, manejo de archivos arrastrados en la terminal nativa: https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/browser/terminalInstance.ts
- VS Code, formatos de datos del arrastre: https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/dnd.ts
- Webviews y eventos de arrastre: https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/webview/browser/pre/index.html
- VS Code 1.140.0, bloqueo temporal de eventos de puntero del iframe durante un arrastre: https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/contrib/webview/browser/webviewElement.ts
- MDN, recepción de archivos del arrastre: https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API/File_drag_and_drop
- xterm.js, pegado: https://xtermjs.org/docs/api/terminal/classes/terminal/#paste
- OpenCode, contexto automático del IDE: https://opencode.ai/docs/ide/
- Claude Code, Attach Open File y selección: https://code.claude.com/docs/en/vs-code
- VS Code, instalación privada desde VSIX: https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#install-from-a-vsix
