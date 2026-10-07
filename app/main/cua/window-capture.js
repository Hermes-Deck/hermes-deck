"use strict";
// Chromium's window video path uses Windows Graphics Capture; GDI thumbnails can be stale on GPU games.
const path = require("node:path");
const { readWindow } = require("./frontmost");
const active = new Map();
const sameBounds = (a, b) => !!a && !!b && ["x", "y", "width", "height"].every(k => a[k] === b[k]);
// The window's video frame is either its full rect or its DWM visible frame. On a scaled display (e.g. 150%) DWM
// rounds the visible frame one pixel differently from the captured video, so sizes may differ by up to 2 px; an exact
// match wins. This function also runs inside the capture page (embedded with toString), so it stays self-contained.
function videoSource(g, w, h) {
  const exact = [g.full, g.visible].find(b => b.width === w && b.height === h);
  return exact || [g.full, g.visible].find(b => Math.abs(b.width - w) <= 2 && Math.abs(b.height - h) <= 2);
}

async function captureWindow(target, frame, authorized) {
  const { BrowserWindow, desktopCapturer, nativeImage } = require("electron");
  const check = () => { if (!authorized()) throw Error("The window selection has ended"); };
  check();
  const before = await readWindow({ target });
  check();
  if (!before.bounds || ![before.bounds.x, before.bounds.y, before.bounds.width, before.bounds.height, frame.width].every(Number.isSafeInteger)
      || before.bounds.width < 1 || before.bounds.height < 1 || before.bounds.width > 8192 || before.bounds.height > 8192
      || before.bounds.width * before.bounds.height > 32000000 || frame.width < 1 || frame.width > 8192
      || (frame.height !== undefined && (!Number.isSafeInteger(frame.height) || frame.height < 1 || frame.height > 8192))) throw Error("Window capture dimensions unsupported");
  if (frame.bounds && !sameBounds(before.bounds, frame.bounds) && !sameBounds(before.extendedBounds, frame.bounds)) throw Error("Window bounds changed; capture again");
  const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 } });
  const source = sources.find(s => s.id === `window:${target.id}:0`);
  if (!source) throw Error("The selected window is unavailable");
  check();
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, partition: "window-capture" } });
  const workerId = win.webContents.id;
  active.set(workerId, { win, authorized });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", e => e.preventDefault());
  const mediaAllowed = (wc, permission, details = {}) => {
    const entry = active.get(wc?.id);
    return permission === "media" && !!entry && entry.authorized() && details.mediaType !== "audio" && !(details.mediaTypes || []).includes("audio");
  };
  win.webContents.session.setPermissionCheckHandler((wc, permission, _origin, details) => mediaAllowed(wc, permission, details));
  win.webContents.session.setPermissionRequestHandler((wc, permission, answer, details) => answer(mediaAllowed(wc, permission, details)));
  win.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_d, answer) => answer({ cancel: true }));
  let timer;
  try {
    await win.loadFile(path.join(__dirname, "../../renderer/window-capture.html"));
    check();
    const geometry = { expected: frame.bounds || before.bounds, full: before.bounds, visible: before.extendedBounds || before.bounds };
    const capture = win.webContents.executeJavaScript(`(async()=>{
      const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{mandatory:{chromeMediaSource:'desktop',chromeMediaSourceId:${JSON.stringify(source.id)}}}});
      try {
        const video=document.querySelector('video');video.srcObject=stream;await video.play();
        await new Promise(resolve=>video.requestVideoFrameCallback(resolve));
        const g=${JSON.stringify(geometry)};
        const source=(${videoSource.toString()})(g,video.videoWidth,video.videoHeight);
        if(!source)throw Error('Window video dimensions differ from native bounds');
        const canvas=document.createElement('canvas');canvas.width=g.expected.width;canvas.height=g.expected.height;
        const ctx=canvas.getContext('2d');ctx.fillStyle='black';ctx.fillRect(0,0,canvas.width,canvas.height);
        ctx.drawImage(video,source.x-g.expected.x,source.y-g.expected.y);return canvas.toDataURL('image/png');
      } finally {stream.getTracks().forEach(t=>t.stop());}
    })()`);
    const url = await Promise.race([capture, new Promise((_r, reject) => { timer = setTimeout(() => reject(Error("Window video capture timed out")), 5000); })]);
    check();
    const after = await readWindow({ target });
    check();
    if (!sameBounds(before.bounds, after.bounds) || !sameBounds(before.extendedBounds || before.bounds, after.extendedBounds || after.bounds)) throw Error("Window bounds changed; capture again");
    let image = nativeImage.createFromDataURL(url);
    if (image.isEmpty()) throw Error("Window video capture returned no frame");
    if (frame.bounds) {
      const size = image.getSize();
      if (size.width !== frame.bounds.width || size.height !== frame.bounds.height) throw Error("Window video frame differs from native bounds");
    }
    image = image.resize({ width: frame.width, ...(frame.height ? { height: frame.height } : {}) });
    return image.toPNG();
  } finally {
    clearTimeout(timer);
    active.delete(workerId);
    if (!win.isDestroyed()) win.destroy();
  }
}
function cancelCaptures() { for (const { win } of active.values()) if (!win.isDestroyed()) win.destroy(); active.clear(); }
module.exports = { captureWindow, cancelCaptures, sameBounds, videoSource };
