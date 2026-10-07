"use strict";
// The status pet's looks, in menu order: one list for main (settings validation, the pet window, the tray menu)
// and the Settings page. `label` is an i18n key. Sprite skins have art in pets/<id>/ and a skin file in
// pets/skins/<id>.js; orb and agent are drawn in CSS.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PetCatalog = api;
})(typeof window === "object" ? window : globalThis, function () {
  const SKINS = [
    { id: "character", label: "A0184" },
    { id: "owl", label: "pet.owl" },
    { id: "philosopher", label: "pet.philosopher" },
    { id: "leo", label: "pet.leo" },
    { id: "hasret", label: "pet.hasret" },
    { id: "hayat", label: "pet.hayat" },
    { id: "orb", label: "U0334" },
    { id: "agent", label: "A0185" },
  ];
  const IDS = SKINS.map((s) => s.id);
  return { SKINS, IDS, DEFAULT: "character" };
});
