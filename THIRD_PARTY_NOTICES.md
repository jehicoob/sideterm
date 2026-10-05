# Componentes de terceros y procedencia

SideTerm Local no está afiliado a Microsoft, Anthropic, OpenAI ni xterm.js.

## Terminal visual

- **@xterm/xterm 5.5.0**, MIT.
- **@xterm/addon-fit 0.10.0**, MIT.
- Licencia incluida en `licenses/XTERM-MIT.txt`; el CSS conserva su aviso original.

Se reutiliza, sin modificar sus bytes, el pequeño módulo autónomo de terminal
incluido en la distribución oficial de **Playwright 1.57.0**:

```
lib/vite/traceViewer/assets/xtermModule-CsJ4vdCR.js
lib/vite/traceViewer/xtermModule.DYP7pi_n.css
```

Sus nombres locales son `media/vendor/xterm-fit.mjs` y `media/vendor/xterm.css`.
No se incluye Playwright, Chromium ni el visor de trazas en el VSIX. El módulo
exporta exclusivamente Terminal y FitAddon y no requiere recursos remotos.
La envoltura de empaquetado de Playwright se atribuye a Microsoft bajo Apache-2.0;
se incluyen su licencia y NOTICE en `licenses/`.

Las versiones se contrastaron con el lockfile de la etiqueta v1.57.0:
https://raw.githubusercontent.com/microsoft/playwright/v1.57.0/package-lock.json

Fuente de licencia xterm:
https://raw.githubusercontent.com/xtermjs/xterm.js/5.5.0/LICENSE

## Integridad de los recursos incluidos

```text
4aa82b0448cef1cf951bbe0ac80bf2d2b7c5d279dd74bcc798a9e563e98e5295  media/vendor/xterm-fit.mjs
7c5a01f382f76539fc9b4db6b18e18a7035741845fd14968c5cdc0a7e373d817  media/vendor/xterm.css
```

Esta copia queda fijada a esas versiones, no se actualiza desde una CDN ni al
abrir la extensión. Para actualizarla se debe sustituir deliberadamente el
bundle, conservar las licencias, actualizar sus hashes y ejecutar las pruebas.
