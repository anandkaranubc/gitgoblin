/**
 * Text from issues, pull requests, commit subjects and the model reaches the terminal through the
 * CLI. A string there can carry escape sequences that restyle the screen, rewrite earlier lines or
 * plant a fake hyperlink, and Unicode controls that hide or reorder what is shown. `plain` removes
 * them and keeps everything else, including tabs, newlines and ordinary non-ASCII text.
 */

// ESC ] ... terminated by BEL or ESC \ (operating system commands: hyperlinks, window titles).
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
// ESC [ ... final byte (CSI: colours, cursor movement, erasing).
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
// Any other ESC followed by one byte.
const ESCAPE = /\u001b[\s\S]/g;
// C0 controls except tab and newline (carriage return included, so a line cannot be overwritten), DEL, and C1 controls.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F\u0080-\u009F]/g;
// Zero-width characters, bidirectional embeddings, overrides and isolates, and the byte-order mark.
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

export function plain(text: string): string {
  return text.replace(OSC, "").replace(CSI, "").replace(ESCAPE, "").replace(CONTROL, "").replace(INVISIBLE, "");
}
