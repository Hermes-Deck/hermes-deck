"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../renderer/i18n");
// A11: the tray icon (the app coin from build/icon.png, at the sizes the OS asks for) and its menu.
const { Tray, Menu, nativeImage } = require("electron");

/** build/icon.png is 512 px; the tray wants 16 px at 100% scale, more on HiDPI screens. */
function trayImage(file) {
  const src = nativeImage.createFromPath(file);
  if (src.isEmpty()) return src;
  const img = nativeImage.createEmpty();
  for (const scale of [1, 1.25, 1.5, 2]) {
    const px = Math.round(16 * scale);
    img.addRepresentation({ scaleFactor: scale, width: px, height: px, buffer: src.resize({ width: px, height: px, quality: "best" }).toPNG() });
  }
  return img;
}

/** Bot screen: the coin in amphora red (main/badge.js), same sizes as trayImage. */
function alertImage() {
  const { alertPng } = require("./badge");
  const img = nativeImage.createEmpty();
  for (const scale of [1, 1.25, 1.5, 2]) {
    const px = Math.round(16 * scale);
    img.addRepresentation({ scaleFactor: scale, width: px, height: px, buffer: alertPng(px) });
  }
  return img;
}

class DeckTray {
  /**
   * @param {object} o
   * @param {string} o.icon  path to build/icon.png
   * @param {() => void} o.onShow
   * @param {(flag: "pet"|"notifications", on: boolean) => void} o.onToggle
   * @param {(skin: "character"|"orb"|"agent") => void} [o.onSkin]  the pet's look (A10)
   * @param {() => void} o.onQuit  really quits, also when closing only hides the window
   */
  constructor({ icon, onShow, onToggle, onSkin = () => {}, onQuit }) {
    Object.assign(this, { onShow, onToggle, onSkin, onQuit });
    this.flags = { pet: false, notifications: true, petSkin: "character" };
    this.img = trayImage(icon);
    this.alerting = null; // bot screen: {text, stopLabel, onStop} while an agent may act on this computer
    this.statusText = "";
    this.tray = new Tray(this.img);
    this.tray.setToolTip("Hermes Deck");
    // macOS opens the menu on click; elsewhere a click brings the deck forward and right-click has the menu
    if (process.platform !== "darwin") this.tray.on("click", () => this.onShow());
    this._menu();
  }

  /** Checkbox states follow the settings, whoever changed them. */
  update(flags) {
    this.flags = { pet: !!flags.pet, notifications: !!flags.notifications, petSkin: flags.petSkin || "character" };
    this._menu();
  }

  /** Tooltip: the same summary the pet's bar shows. */
  status(text) {
    this.statusText = text || "";
    if (this.alerting) return; // the alert's text stays until it ends
    this.tray.setToolTip(text ? `Hermes Deck · ${text}`.slice(0, 120) : "Hermes Deck");
  }

  /**
   * Bot screen (main/cua): red icon, the alert as tooltip and a "Durdur" item on top of the menu while an
   * agent may act on this computer. alert(false) restores the normal icon.
   * @param {boolean} on
   * @param {{text: string, stopLabel?: string, onStop: () => void}} [info]
   */
  alert(on, info) {
    if (this.tray.isDestroyed()) return;
    this.alerting = on && info ? info : null;
    if (this.alerting && !this.alertImg) this.alertImg = alertImage();
    this.tray.setImage(this.alerting ? this.alertImg : this.img);
    if (this.alerting) this.tray.setToolTip(`Hermes Deck · ${this.alerting.text}`.slice(0, 120));
    else this.status(this.statusText);
    this._menu();
  }

  _menu() {
    const a = this.alerting;
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        ...(a ? [{ label: a.stopLabel || i18nText("A0182"), click: () => a.onStop() }, { type: "separator" }] : []),
        { label: i18nText("U0332"), click: () => this.onShow() },
        { type: "separator" },
        { label: i18nText("A0183"), type: "checkbox", checked: this.flags.pet, click: (item) => this.onToggle("pet", item.checked) },
        // A10: the pet's look, the same choice as Settings → Masaüstü → Pet görünümü
        {
          label: i18nText("U0333"),
          submenu: require("../renderer/pets/catalog").SKINS.map(({ id, label }) => ({
            label: i18nText(label),
            type: "radio",
            checked: this.flags.petSkin === id,
            click: () => this.onSkin(id),
          })),
        },
        { label: i18nText("A0186"), type: "checkbox", checked: this.flags.notifications, click: (item) => this.onToggle("notifications", item.checked) },
        { type: "separator" },
        { label: i18nText("U0335"), click: () => this.onQuit() },
      ])
    );
  }

  destroy() {
    if (!this.tray.isDestroyed()) this.tray.destroy();
  }
}

module.exports = { DeckTray };
