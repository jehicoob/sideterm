# SideTerm Local 0.2.0 — Pruebas y límites

## Cambios de 0.2.0 (macOS)

- Entorno: macOS 15 (Darwin 24.6, Apple Silicon), Python 3.14 y Node 24. **Python: 28 pruebas correctas, 0 omitidas**; **Node: 49 correctas**, incluida una nueva para `-l -i` por defecto en macOS. PTYs reales con `/bin/bash` 3.2 y `/bin/zsh -l -i`, recorrido real `node → opencode` y limpieza de descendientes que ignoran `SIGHUP`.
- **No se ejecutó** en macOS: la prueba de Chromium (`tests/browser-smoke.py`, sin Playwright instalado), VS Code real en macOS ni el arrastre desde el Finder o el Explorador. La captura de `Option`/`Cmd` es la misma de 0.1.5 y sigue sin prueba automatizada.
- Linux/WSL2: el código de `/proc` no cambió, pero **no se reejecutó** la suite en Linux tras esta modificación; las pruebas simuladas de `/proc` se fijan al backend `proc`.

## Cambios de 0.1.4 y 0.1.5

- Node: una prueba nueva verifica que **SideTerm: Enfocar terminal** muestra la vista y pide a la interfaz enfocar la pestaña activa.
- Diagnóstico del foco en VS Code 1.140.0 real (Windows + WSL2), con registros de consola del usuario dentro de la webview y en el workbench. El cuadro de texto de xterm conservaba el foco al volver de Alt+Tab. A la primera letra, VS Code llamó a `focus()` sobre `menubar-menu-button` desde `MenuBar.onModifierKeyToggled`. El mecanismo se contrastó con el código fuente de VS Code 1.140.0 (`ModifierKeyEmitter` en `dom.ts`, `menubar.ts`, `pre/index.html`).
- El bloqueo de Alt sin otra tecla vive en la webview y **no tiene prueba automatizada**, porque Chromium/Playwright no están instalados. Falta confirmarlo repitiendo el flujo en VS Code real.

## Cambios de 0.1.3

- Node: **45 pruebas correctas**; 5 nuevas para la vista **Soltar archivos** y el comando del Explorador (solo `text/uri-list`, rutas entre comillas sin Enter en la pestaña activa, selección múltiple, sin pestaña en ejecución, host remoto ajeno, lista vacía y ruta inexistente). Una prueba hace fallar cualquier lectura del editor activo o del portapapeles.
- Python: 28 pruebas ejecutadas, sin fallos.
- Chromium: **no se ejecutó** en 0.1.3 porque Playwright y Chromium no están instalados en esta máquina. El ajuste de la última fila (desplazamientos en lugar de `padding` en `.terminal-pane`) no tiene todavía comprobación visual.
- No se ha probado en VS Code real que el Explorador entregue `text/uri-list` a la vista nativa en Windows + WSL2.

Los resultados siguientes corresponden a 0.1.2.

## Resultado

- TypeScript del host y de la interfaz: compila con `strict` y `noEmitOnError`.
- Python: 28 pruebas ejecutadas, **27 correctas y una omitida**.
- Node: **40 pruebas correctas**, incluidos 18 casos nuevos de rutas, transferencia y host.
- Chromium: **27 comprobaciones correctas** de interfaz con PTYs reales.
- Total: **94 comprobaciones correctas; una omitida**. No se incluyen como pruebas adicionales las comprobaciones repetidas durante desarrollo.

La prueba Python omitida requiere `/proc/.../children` para observar un wrapper real; el kernel del entorno no lo expone. La política de recorrido se prueba por separado con datos simulados.

## Cobertura nueva

1. Archivos y directorios reales accesibles; rutas inexistentes rechazan la operación completa.
2. Rutas con espacios, Unicode, apóstrofes y caracteres de shell; comillas sin expansión ni Enter automático.
3. URIs de VS Code/WSL, URI `file:`, rutas de unidad Windows y UNC de la misma distribución. **Conversión `wslpath` simulada en las pruebas: no hay Windows/WSL real en este entorno.**
4. Rechazo de otros hosts, URLs web, rutas relativas, controles, metadatos excesivos y más de 16 entradas.
5. Se utiliza una sola representación MIME completa del arrastre, sin acumular duplicados. Un `CodeEditors` distinto no se añade a una lista de rutas explícitas.
6. Una prueba hace fallar intencionadamente cualquier lectura del editor activo o del portapapeles: el arrastre explícito sigue funcionando.
7. Un arrastre sin ruta no usa el archivo abierto como fallback.
8. Las copias sin ruta original exigen confirmación. Cancelar no crea una transferencia ni pega texto.
9. Transferencia binaria por bloques de 64 KiB con confirmación y posiciones verificadas. Los bytes de destino coinciden con los enviados.
10. Directorio temporal 0700, archivos 0600; eliminación al cerrar sesión/vista; el cierre de una sesión no borra los archivos de otra.
11. Transferencias incompletas, secuencias fuera de orden y sesión equivocada son rechazadas.
12. El destino se conserva aunque el usuario cambie de pestaña; si la pestaña ya no existe, no se redirige a otra.
13. Eventos `DragEvent` sintéticos en Chromium → interfaz real → código del host real con API de VS Code simulada → PTY real → argumentos verificados en un archivo de salida. El archivo de salida no existe hasta que el test pulsa Enter explícitamente.

Un fallo de limpieza de copias temporales no impide detener los PTY: se verifica con un error de eliminación inyectado.

## Regresiones

Se mantienen las pruebas de títulos dinámicos, rutas actuales, vuelta al shell, nombres manuales, ancho equitativo y mínimo de pestañas, señales, cambio de tamaño, texto Unicode/ANSI, TUI con pantalla alternativa, pegado multilínea, flujo acotado, sesiones independientes, salida en pestañas no seleccionadas, cierre de procesos y políticas CSP/OSC 52.

## Lo que no se probó

- Instalación/ejecución del nuevo VSIX en VS Code real, Windows o WSL.
- Arrastre nativo desde Windows Explorer, desde una ventana real de VS Code o entre ventanas del sistema. Los formatos se basan en el código fuente de VS Code y las interacciones de navegador usan `DataTransfer`/`DragEvent` sintéticos.
- Agentes autenticados (OpenCode/Claude/Codex) interpretando las rutas de imágenes o documentos.
- Origen exacto del supuesto adjunto automático del archivo abierto en el equipo del usuario. SideTerm no usa el editor activo; otras integraciones pueden hacerlo.
- Cifras de RAM/CPU total en el equipo del usuario. Se verificó el diseño por eventos y bloques, no se realizó un benchmark Windows.

## Reproducir

En la máquina de desarrollo (no para instalar el VSIX):

```bash
npm install
npm run build
npm test
python3 tests/browser-smoke.py
python3 scripts/package.py --out-dir /ruta/de/salida
```

El test de navegador necesita Playwright y Chromium únicamente en la máquina de pruebas. Su servidor HTTP y el sondeo de mensajes son **infraestructura de test**, no están presentes en el VSIX. La interfaz de prueba se incrusta en `about:blank` debido a las restricciones de navegación del entorno; no modifica políticas del navegador.

Registros: `test-all-012.log` (Python), `test-node-012.log`, `test-browser-012.log`, `browser-test-results.json`. El primer comando combinado de pruebas fue interrumpido por el límite de ejecución después de completar Python; la suite Node se ejecutó completa por separado y su resultado válido está en `test-node-012.log`.
