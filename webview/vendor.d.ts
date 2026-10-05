/** Public subset of the bundled xterm.js API used by this view. */
declare module '*xterm-fit.mjs' {
  interface Disposable { dispose(): void; }
  interface Options {
    cols?: number; rows?: number; fontSize?: number; fontFamily?: string;
    scrollback?: number; cursorBlink?: boolean; theme?: Record<string, string>;
    disableStdin?: boolean; allowProposedApi?: boolean; screenReaderMode?: boolean;
    convertEol?: boolean; scrollOnUserInput?: boolean; allowTransparency?: boolean;
    linkHandler?: {activate(event: MouseEvent, text: string): void};
  }
  class Terminal {
    constructor(options?: Options);
    cols: number; rows: number; options: Options;
    onData(handler: (data: string) => void): Disposable;
    onBinary(handler: (data: string) => void): Disposable;
    onTitleChange(handler: (title: string) => void): Disposable;
    onResize(handler: (size: {cols: number; rows: number}) => void): Disposable;
    parser: { registerOscHandler(id: number, handler: (data: string) => boolean): Disposable };
    loadAddon(addon: FitAddon): void; open(element: HTMLElement): void;
    write(data: string | Uint8Array, callback?: () => void): void;
    focus(): void; clear(): void; dispose(): void; paste(text: string): void;
    hasSelection(): boolean; getSelection(): string; refresh(start: number, end: number): void;
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  }
  class FitAddon { fit(): void; dispose(): void; }
  const xterm: {Terminal: typeof Terminal; FitAddon: typeof FitAddon};
  export default xterm;
}
