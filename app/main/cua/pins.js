"use strict";
// Pinned cua-driver builds. The Deck downloads only what is listed here, refuses any file whose size or
// SHA-256 differs, checks the publisher's code signature before it runs anything, and never follows "latest".
// One entry per platform:
//   { version, platform: "win32-x64" | "win32-arm64" | "darwin-arm64" | "darwin-x64" | "darwin-universal",
//     url: "https://…", sha256: "<64 hex>", size: <bytes>,
//     signer: "<Authenticode signer CN>" (Windows) | teamId: "<Apple team id>" (macOS) }
// Versions must include trycua/cua#3299 (bounded app scoping).

const PINS = [
  {
    version: "0.33.3",
    platform: "win32-x64",
    url: "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.33.3/cua-driver-rs-0.33.3-windows-x86_64.zip",
    sha256: "a0ccee0acc027ea95f639c125fde671e0934a60cf3e2c5e2bbfaf7fc35afdd29",
    size: 31016817,
    signer: "Cua AI, Inc.", // every .exe/.dll/.node in the zip is Authenticode-signed by this publisher
  },
  {
    version: "0.33.3",
    platform: "darwin-universal",
    url: "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.33.3/cua-driver-rs-0.33.3-darwin-universal.tar.gz",
    sha256: "e4d5a6c2f8b1dff776bc7260717b723d753c3deeb020469a6eb85eacf862bfca",
    size: 75255030,
    teamId: "YCK386LBJ7", // Cua AI, Inc.; universal bundle verified with codesign and Gatekeeper on macOS
  },
];

module.exports = { PINS };
