"use strict";
// Writes SHA256SUMS.txt for the release artifacts, in the format `sha256sum -c` (Linux) and
// `shasum -a 256 -c` (macOS) check against.
//   node scripts/checksums.js [folder]     default: dist/ next to this script's app folder
// Lists only what people download: the .exe, .dmg and .zip files at the top of the folder (not the
// unpacked app folders electron-builder leaves beside them).
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const dir = path.resolve(process.argv[2] || path.join(__dirname, "..", "dist"));
const ARTIFACT = /\.(exe|dmg|zip)$/i;
const OUT = "SHA256SUMS.txt";

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function main() {
  if (!fs.existsSync(dir)) throw new Error(`${dir} does not exist`);
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && ARTIFACT.test(e.name))
    .map((e) => e.name)
    .sort(); // code-unit order: the same list on every OS
  if (!files.length) throw new Error(`no .exe, .dmg or .zip files in ${dir}`);
  const lines = [];
  for (const name of files) lines.push(`${await sha256(path.join(dir, name))}  ${name}`);
  fs.writeFileSync(path.join(dir, OUT), `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
  console.log(`checksums: ${files.length} files -> ${path.join(dir, OUT)}`);
}

main().catch((e) => {
  console.error(`checksums: ${e.message}`);
  process.exit(1);
});
