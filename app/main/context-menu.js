"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../renderer/i18n");
// Right-click menu for text: Electron shows none by default, so the composer and other fields had no
// cut/copy/paste. The page's own menus (messages, topics) call preventDefault on contextmenu, and then
// Electron sends no "context-menu" event here, so this never doubles up with them.
const { Menu } = require("electron");

function attachContextMenu(win) {
  win.webContents.on("context-menu", (_e, p) => {
    const items = [];
    const f = p.editFlags || {};
    if (p.isEditable) {
      if (p.misspelledWord && Array.isArray(p.dictionarySuggestions) && p.dictionarySuggestions.length) {
        for (const w of p.dictionarySuggestions.slice(0, 5)) items.push({ label: w, click: () => win.webContents.replaceMisspelling(w) });
        items.push({ type: "separator" });
      }
      items.push(
        { label: i18nText("A0050"), role: "undo", enabled: !!f.canUndo },
        { label: i18nText("A0051"), role: "redo", enabled: !!f.canRedo },
        { type: "separator" },
        { label: i18nText("A0052"), role: "cut", enabled: !!f.canCut },
        { label: i18nText("A0053"), role: "copy", enabled: !!f.canCopy },
        { label: i18nText("U0110"), role: "paste", enabled: !!f.canPaste },
        { type: "separator" },
        { label: i18nText("U0111"), role: "selectAll", enabled: !!f.canSelectAll }
      );
    } else if (p.selectionText && p.selectionText.trim()) {
      items.push({ label: i18nText("A0053"), role: "copy" });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
}

module.exports = { attachContextMenu };
