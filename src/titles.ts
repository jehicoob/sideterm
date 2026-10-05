import * as path from 'node:path';
export interface TitleState {
  cwd: string; shell: string; processName?: string; foreground?: boolean;
  sequenceTitle?: string; customName?: string;
}
export function cleanTitle(value: string, maximum = 160): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '').trim().slice(0, maximum);
}
function sequenceProgram(title: string): string | undefined {
  // Only a recognized application name can replace a generic runtime label.
  // A prompt/command/topic that happens to mention another app must not replace
  // the actual detected OpenCode/Claude/Codex process.
  const match = cleanTitle(title).match(/^[^\p{L}\p{N}]*(opencode|claude|codex)(?=$|[^\p{L}\p{N}_])/iu);
  return match ? ({opencode: 'OpenCode', claude: 'Claude', codex: 'Codex'}[match[1].toLowerCase()]) : undefined;
}
export function tabName(state: TitleState): string {
  let app = cleanTitle(state.processName || path.basename(state.shell), 96) || 'terminal';
  if (state.foreground && /^(node|nodejs|bun|deno|npm|npx|pnpm|yarn)$/.test(app)) {
    app = sequenceProgram(state.sequenceTitle || '') || app;
  }
  app = cleanTitle(state.customName || '', 80) || app;
  const folder = cleanTitle(path.basename(state.cwd) || state.cwd, 160) || '/';
  return `${app} · ${folder}`;
}
