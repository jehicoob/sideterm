"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.cleanTitle = cleanTitle;
exports.tabName = tabName;
const path = __importStar(require("node:path"));
function cleanTitle(value, maximum = 160) {
    return value.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '').trim().slice(0, maximum);
}
function sequenceProgram(title) {
    // Only a recognized application name can replace a generic runtime label.
    // A prompt/command/topic that happens to mention another app must not replace
    // the actual detected OpenCode/Claude/Codex process.
    const match = cleanTitle(title).match(/^[^\p{L}\p{N}]*(opencode|claude|codex)(?=$|[^\p{L}\p{N}_])/iu);
    return match ? ({ opencode: 'OpenCode', claude: 'Claude', codex: 'Codex' }[match[1].toLowerCase()]) : undefined;
}
function tabName(state) {
    let app = cleanTitle(state.processName || path.basename(state.shell), 96) || 'terminal';
    if (state.foreground && /^(node|nodejs|bun|deno|npm|npx|pnpm|yarn)$/.test(app)) {
        app = sequenceProgram(state.sequenceTitle || '') || app;
    }
    app = cleanTitle(state.customName || '', 80) || app;
    const folder = cleanTitle(path.basename(state.cwd) || state.cwd, 160) || '/';
    return `${app} · ${folder}`;
}
