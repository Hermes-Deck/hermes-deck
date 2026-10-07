#!/usr/bin/env node
"use strict";
// A stand-in for Chrome in agent-browser tests: takes Chrome's launch arguments, waits --fake-delay ms (a cold
// start), writes <user-data-dir>/DevToolsActivePort like Chrome does, then stays up until it is killed. It
// opens no port: nothing in these tests connects to it. --fake-log=<file> gets one line per start.
const fs = require("fs");
const path = require("path");

const opt = (name) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};
const dir = opt("user-data-dir");
const delay = Number(opt("fake-delay")) || 0;
if (opt("fake-log")) fs.appendFileSync(opt("fake-log"), `${process.pid}\n`);
setTimeout(() => {
  if (dir) fs.writeFileSync(path.join(dir, "DevToolsActivePort"), "45678\n/devtools/browser/fake-0000\n");
}, delay);
setInterval(() => {}, 60_000); // like a browser: up until killed
