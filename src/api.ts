/** Typed boundary for the public VS Code APIs used here. No private workbench APIs.
 * Kept deliberately small so the prebuilt package has zero npm runtime dependencies.
 * API contracts: https://code.visualstudio.com/api/references/vscode-api
 */
export interface Disposable { dispose(): unknown; }
export type Event<T> = (listener: (event: T) => unknown) => Disposable;
export interface Uri { fsPath: string; scheme: string; authority?: string; toString(): string; }
export interface WorkspaceFolder { name: string; uri: Uri; index: number; }
export interface Configuration { get<T>(key: string, fallback: T): T; }
export interface OutputChannel extends Disposable { appendLine(value: string): void; show(preserveFocus?: boolean): void; }
export interface Webview {
  html: string;
  cspSource: string;
  options: { enableScripts?: boolean; localResourceRoots?: Uri[] };
  asWebviewUri(uri: Uri): Uri;
  postMessage(message: unknown): PromiseLike<boolean>;
  onDidReceiveMessage: Event<unknown>;
}
export interface WebviewView extends Disposable {
  webview: Webview; visible: boolean;
  onDidDispose: Event<void>;
  onDidChangeVisibility: Event<void>;
  show(preserveFocus?: boolean): void;
}
export interface ExtensionContext {
  extensionUri: Uri;
  extensionPath: string;
  subscriptions: Disposable[];
}
export interface Api {
  Uri: { joinPath(base: Uri, ...segments: string[]): Uri; file(path: string): Uri; };
  window: {
    createOutputChannel(name: string): OutputChannel;
    registerWebviewViewProvider(id: string, provider: { resolveWebviewView(view: WebviewView): unknown }, options: {webviewOptions: {retainContextWhenHidden: boolean}}): Disposable;
    showInformationMessage(message: string, options: {modal?: boolean; detail?: string}, ...items: string[]): PromiseLike<string | undefined>;
    showWarningMessage(message: string, options: {modal?: boolean; detail?: string}, ...items: string[]): PromiseLike<string | undefined>;
    showErrorMessage(message: string, ...items: string[]): PromiseLike<string | undefined>;
    showInputBox(options: {prompt: string; value?: string; ignoreFocusOut?: boolean; validateInput?: (value: string) => string | undefined}): PromiseLike<string | undefined>;
    showQuickPick<T extends {label: string; description?: string; detail?: string}>(items: readonly T[], options: {placeHolder?: string; ignoreFocusOut?: boolean}): PromiseLike<T | undefined>;
    showOpenDialog(options: {canSelectFiles: boolean; canSelectFolders: boolean; canSelectMany: boolean; openLabel?: string; defaultUri?: Uri}): PromiseLike<Uri[] | undefined>;
  };
  commands: {
    registerCommand(id: string, handler: (...args: unknown[]) => unknown): Disposable;
    executeCommand<T = unknown>(id: string, ...args: unknown[]): PromiseLike<T>;
  };
  workspace: {
    isTrusted: boolean;
    workspaceFolders: readonly WorkspaceFolder[] | undefined;
    getConfiguration(section: string): Configuration;
    onDidChangeConfiguration: Event<{affectsConfiguration(section: string): boolean}>;
  };
  env: { remoteName: string | undefined; appName: string; clipboard: {readText(): PromiseLike<string>; writeText(text: string): PromiseLike<void>}; };
  version: string;
}
// VS Code injects this module inside the extension host.
export const vscode: Api = require('vscode') as Api;
