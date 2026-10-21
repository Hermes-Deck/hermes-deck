"use strict";
// Writes app/main/build-info.json before a packaged build (npm run dist*): the commit, branch and GitHub repository
// the app was built from, so the installed app can ask GitHub how far main has moved since (main/update-check.js).
// A dev checkout has no such file; update-check.js then asks git directly. Nothing else in the app reads it.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const APP = path.join(__dirname, "..");
const git = (...args) => {
  try {
    return execFileSync("git", args, { cwd: APP, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

/** "owner/name" from a GitHub remote URL (https or ssh), or "". */
function repoOf(url) {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url || "");
  return m ? `${m[1]}/${m[2]}` : "";
}

function releaseInfo(env = process.env, version = require("../package.json").version) {
  const { TEST_TAG, STABLE_TAG } = require("../main/update-check");
  const releaseTag = env.DECK_RELEASE_TAG || "";
  if (releaseTag && !((TEST_TAG.test(releaseTag) || STABLE_TAG.test(releaseTag)) && releaseTag.replace(/^v/, "").split("-test.")[0] === version)) throw new Error("DECK_RELEASE_TAG must match the package version (vX.Y.Z or vX.Y.Z-test.N)");
  if (env.DECK_UPDATE_CHANNEL && !["stable", "test"].includes(env.DECK_UPDATE_CHANNEL)) throw new Error("Invalid DECK_UPDATE_CHANNEL");
  const channel = releaseTag ? (TEST_TAG.test(releaseTag) ? "test" : "stable") : env.DECK_UPDATE_CHANNEL || "stable";
  if (releaseTag && env.DECK_UPDATE_CHANNEL && channel !== env.DECK_UPDATE_CHANNEL) throw new Error("Release tag/channel mismatch");
  return { channel, releaseTag };
}

function main() {
  const info = {
    ...releaseInfo(),
    commit: git("rev-parse", "HEAD"),
    branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    repo: repoOf(git("remote", "get-url", "origin")),
    dirty: git("status", "--porcelain", "--untracked-files=no") !== "",
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(APP, "main", "build-info.json"), JSON.stringify(info, null, 2) + "\n");
  console.log(`build-info: ${info.commit.slice(0, 7) || "(no git)"} on ${info.branch || "?"} from ${info.repo || "?"}${info.dirty ? " (uncommitted changes)" : ""}`);
}

if (require.main === module) main();

module.exports = { repoOf, releaseInfo };
