"use strict";
// Electron appshots check: hidden window, synthetic captures, Telegram fixture and local fake Hermes only.
// electron app/scripts/appshots-e2e.js --user-data-dir=<isolated-directory>
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-appshots-"));
const fixture = path.join(dir, "fixture.json");
fs.writeFileSync(fixture, JSON.stringify({ uploadMs: 100, me: { id: "1", name: "Example" }, dialogs: { bots: [{ key: "u7001", id: "7001", title: "Atlas" }], topics: [] }, relay: { agents: { Atlas: { name: "Atlas", profile: "atlas", botUsername: "example_bot", running: false } }, sessions: [] }, messages: { u7001: [] } }));
process.argv.push(`--shot=${path.join(dir, "unused.png")}`, `--fixture=${fixture}`, "--botscreen=idle", "--bridge-fake", "--select=u7001", "--tab=screen", "--wait=60000");
process.on("uncaughtException", (e) => { console.error(e.stack); app.exit(1); });
setTimeout(() => { console.error("appshots check timed out"); app.exit(1); }, 45000).unref();
app.on("browser-window-created", (_e, win) => {
  assert.equal(win.isVisible(), false);
  win.on("show", () => { throw new Error("Fixture window became visible"); });
  win.webContents.on("console-message", (_e, details) => { if (details.level === "error") console.error(details.message); });
  win.webContents.once("did-finish-load", async () => {
    try {
      const result = await win.webContents.executeJavaScript(`(async () => {
        const check = (ok, message) => { if (!ok) throw new Error(message); };
        const wait = async (fn, label) => { const until = Date.now() + 8000; while (!await fn()) { if (Date.now() > until) throw new Error('UI timeout: ' + label); await new Promise(r => setTimeout(r, 30)); } };
        const painted = async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); };
        const shotButton = () => document.querySelector('[aria-label="' + window.DeckI18n.t('appshot.add') + '"]');
        const clickShot = () => shotButton().click();
        await wait(() => document.querySelector('#head .title') && document.querySelector('#head .title').textContent === 'Atlas');
        check(window.DeckI18n.getLanguage() === 'en' && document.documentElement.lang === 'en', 'English is not the default');
        check(window.DeckI18n.getLocale() === 'en-US', 'Wrong default locale');
        clickShot();
        await wait(() => document.querySelector('.att-text'));
        check(!!document.querySelector('.att-thumb'), 'No screenshot preview');
        check(document.querySelector('.att-text pre').textContent.includes('Example window text'), 'No text preview');
        check(document.querySelectorAll('.msg').length === 0, 'Capture sent without a click');
        document.querySelector('.att-x').click();
        await wait(() => !document.querySelector('.att'));
        clickShot();
        await wait(() => document.querySelector('.att'));
        const staged = {
          token: document.querySelector('.att').dataset.token,
          name: document.querySelector('.att-name').textContent,
          preview: document.querySelector('.att-thumb').src,
          text: document.querySelector('.att-text pre').textContent,
        };
        const draft = 'Review this';
        document.querySelector('#input').value = draft;
        document.querySelector('#input').dispatchEvent(new Event('input'));
        document.querySelector('[data-fk="tab:settings"]').click();
        await wait(() => document.querySelector('#s-language'), 'language setting');
        const beforeSettings = await deck.settingsGet();
        const secrets = { 's-relay-token': 'fixture-unsaved-relay-token', 's-apihash': 'fixture-unsaved-api-hash' };
        for (const [id, value] of Object.entries(secrets)) {
          const field = document.getElementById(id); field.value = value; field.dispatchEvent(new Event('input'));
        }
        const botsCheck = () => document.querySelector('#settings-chat-modes input[type="checkbox"][value="bots"]');
        const botsDraft = !botsCheck().checked;
        botsCheck().checked = botsDraft; botsCheck().dispatchEvent(new Event('change'));
        for (const language of ['tr', 'en']) {
          const select = document.querySelector('#s-language');
          select.value = language;
          select.dispatchEvent(new Event('change'));
          await wait(async () => window.DeckI18n.getLanguage() === language && document.documentElement.lang === language &&
            (await deck.settingsGet()).language === language && document.querySelector('#s-language').value === language, 'saved language ' + language);
          await wait(() => shotButton() && document.querySelector('.att-text summary').textContent === window.DeckI18n.t('appshot.windowText') &&
            document.querySelector('label[for="s-language"] .flabel').textContent === window.DeckI18n.t('settings.language'), 'translated chrome ' + language);
          await painted();
          for (const [id, value] of Object.entries(secrets)) check(document.getElementById(id).value === value, 'Language change lost unsaved ' + id);
          check(botsCheck().checked === botsDraft, 'Language change lost the unsaved bot mode');
          const saved = await deck.settingsGet();
          check(JSON.stringify(saved.chat) === JSON.stringify(beforeSettings.chat) && saved.relay.hasToken === beforeSettings.relay.hasToken && saved.telegram.hasApiHash === beforeSettings.telegram.hasApiHash, 'Language change persisted unsaved settings');
          check(window.DeckI18n.getLocale() === (language === 'tr' ? 'tr-TR' : 'en-US'), 'Wrong locale after language change');
          check(document.querySelector('#input').value === draft, 'Language change lost the composer draft');
          check(document.querySelector('.att').dataset.token === staged.token && document.querySelector('.att-name').textContent === staged.name, 'Language change replaced the attachment');
          check(document.querySelector('.att-thumb').src === staged.preview && document.querySelector('.att-text pre').textContent === staged.text, 'Language change altered captured data');
          check(document.querySelector('#head .title').textContent === 'Atlas', 'Language change translated fixture data');
          check(document.querySelectorAll('.msg').length === 0, 'Language change sent a pending message');
        }
        document.querySelector('#send').click();
        await wait(() => !document.querySelector('.att'));
        check(document.querySelector('#note').textContent === '', 'Fixture Telegram send failed');
        document.querySelector('[data-fk="tab:screen"]').click();
        await wait(() => document.querySelector('.bs-actions button'), 'screen actions');
        const front = [...document.querySelectorAll('.bs-actions button')].find(x => x.textContent === window.DeckI18n.t('frontmost.window'));
        check(front && !front.disabled, 'Frontmost consent action unavailable');
        front.click();
        await wait(() => document.querySelector('.bs-pick-sum'), 'prefilled consent');
        check(document.querySelector('.bs-pick-sum').textContent.includes('Excel'), 'Consent not prefilled');
        check(!(await deck.botscreen.state()).grant, 'Consent action granted without confirmation');
        document.querySelector('.bs-x').click();
        document.querySelector('[data-fk="tab:settings"]').click();
        await wait(() => document.querySelector('#s-br-mode'), 'bridge settings');
        const mode = document.querySelector('#s-br-mode');
        mode.value = 'wsl'; mode.dispatchEvent(new Event('change'));
        for (const [id, value] of [['s-br-python','/usr/bin/python3'],['s-br-stream','/srv/example/stream.py']]) {
          const field = document.getElementById(id); field.value = value; field.dispatchEvent(new Event('input'));
        }
        document.querySelector('.hb-status').previousElementSibling.querySelector('.primary').click();
        await wait(async () => (await deck.bridge.status()).status.status === 'open', 'fake bridge open');
        await wait(() => document.querySelector('[data-fk="chan:sessions"]'), 'channel switch');
        document.querySelector('[data-fk="chan:sessions"]').click();
        await wait(() => document.querySelector('#head .title') && document.querySelector('#head .title').textContent !== 'Atlas', 'Hermes chat');
        clickShot();
        await wait(() => document.querySelector('.att'));
        document.querySelector('#input').value = 'Describe this window';
        document.querySelector('#send').click();
        await wait(() => !document.querySelector('.att'));
        check(!document.querySelector('#note').classList.contains('bad'), 'Fixture Hermes send failed');
        return 'English default, en→tr→en with draft, appshot and unsaved settings preserved, preview, remove, explicit Telegram send, prefilled consent and explicit Hermes send passed';
      })()`);
      console.log(result);
      await win.webContents.executeJavaScript(`document.querySelector('[data-fk="chan:telegram"]').click()`);
      for (const [id, status] of [['f-pass', { t: 'status', status: 'login', step: 'password' }], ['f-apihash', { t: 'status', status: 'setup' }]]) {
        win.webContents.send('tg', status); // renderer-only synthetic UI state; never starts login or setup
        await win.webContents.executeJavaScript(`(async () => {
          const check = (ok, message) => { if (!ok) throw new Error(message); };
          const wait = async (fn, label) => { const until = Date.now() + 8000; while (!await fn()) { if (Date.now() > until) throw new Error('UI timeout: ' + label); await new Promise(r => setTimeout(r, 30)); } };
          const id = ${JSON.stringify(id)}, draft = 'fixture-unsaved-' + id;
          await wait(() => document.getElementById(id), id + ' form');
          const before = (await deck.history('u7001')).length;
          const field = document.getElementById(id); field.value = draft; field.dispatchEvent(new Event('input'));
          for (const language of ['tr', 'en']) {
            const select = document.querySelector('#s-language'); select.value = language; select.dispatchEvent(new Event('change'));
            await wait(async () => window.DeckI18n.getLanguage() === language && (await deck.settingsGet()).language === language &&
              document.querySelector('label[for="s-language"] .flabel').textContent === window.DeckI18n.t('settings.language'), id + ' language ' + language);
            await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
            check(document.getElementById(id).value === draft, 'Language change lost unsaved ' + id);
            check((await deck.history('u7001')).length === before, 'Language change sent a fixture message');
          }
        })()`);
      }
      win.webContents.send('tg', { t: 'status', status: 'open' });
      await win.webContents.executeJavaScript(`(async () => {
        const until = Date.now() + 8000;
        while (document.querySelector('#f-pass, #f-apihash') || document.querySelector('[data-fk="chan:telegram"]').getAttribute('aria-pressed') !== 'true') {
          if (Date.now() > until) throw new Error('Fixture Telegram state was not restored');
          await new Promise(r => setTimeout(r, 30));
        }
      })()`);
      console.log('Synthetic login password and setup API hash survive en→tr→en; Telegram open state restored');
      await win.webContents.executeJavaScript(`(async () => {
        const check = (ok, message) => { if (!ok) throw new Error(message); };
        const wait = async (fn, label) => { const until = Date.now() + 8000; while (!await fn()) { if (Date.now() > until) throw new Error('UI timeout: ' + label); await new Promise(r => setTimeout(r, 30)); } };
        for (const id of ['s-relay-token', 's-apihash']) document.getElementById(id).value = '';
        const bots = document.querySelector('#settings-chat-modes input[type="checkbox"][value="bots"]');
        bots.checked = (await deck.settingsGet()).chat.modes.includes('bots'); bots.dispatchEvent(new Event('change'));
        check(!document.querySelector('#input').value && !document.querySelector('.att'), 'Reload would discard an unsent message');
        for (const language of ['tr', 'en']) {
          const select = document.querySelector('#s-language'); select.value = language; select.dispatchEvent(new Event('change'));
          await wait(async () => window.DeckI18n.getLanguage() === language && (await deck.settingsGet()).language === language, 'workspace language ' + language);
          await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
          document.querySelector('[data-fk="tab:workspace"]').click();
          await wait(() => document.querySelector('.ws-newtab'), 'workspace mounted');
          await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
          const newTab = document.querySelector('.ws-newtab');
          check(newTab.title === window.DeckI18n.t(newTab.disabled ? 'U0935' : 'A0377') && newTab.textContent === window.DeckI18n.t('A0378'), 'Detached new-tab control did not translate');
          const nav = [...document.querySelectorAll('.ws-nav')];
          check(nav.length === 3, 'Workspace navigation unavailable');
          ['A0340', 'U0776', 'A0376'].forEach((key, index) => check(nav[index].title === window.DeckI18n.t(key) && nav[index].getAttribute('aria-label') === window.DeckI18n.t(key), 'Detached navigation did not translate: ' + key));
          document.querySelector('[data-fk="tab:settings"]').click();
          await wait(() => document.querySelector('#s-language'), 'settings restored');
        }
        const select = document.querySelector('#s-language'); select.value = 'tr'; select.dispatchEvent(new Event('change'));
        await wait(async () => window.DeckI18n.getLanguage() === 'tr' && (await deck.settingsGet()).language === 'tr', 'Turkish before reload');
        await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
        check(!document.querySelector('#input').value && !document.querySelector('.att') && ![...document.querySelectorAll('input[type="password"]')].some(field => field.value), 'Reload would discard a draft or secret');
      })()`);
      await new Promise((resolve) => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
      await win.webContents.executeJavaScript(`(async () => {
        const wait = async (fn, label) => { const until = Date.now() + 8000; while (!await fn()) { if (Date.now() > until) throw new Error('UI timeout: ' + label); await new Promise(r => setTimeout(r, 30)); } };
        await wait(() => document.querySelector('[data-fk="tab:settings"]'), 'reloaded tabs');
        document.querySelector('[data-fk="tab:settings"]').click();
        await wait(async () => document.querySelector('#s-language')?.value === 'tr' && window.DeckI18n.getLanguage() === 'tr' &&
          document.documentElement.lang === 'tr' && window.DeckI18n.getLocale() === 'tr-TR' && (await deck.settingsGet()).language === 'tr', 'saved Turkish locale after reload');
        const select = document.querySelector('#s-language'); select.value = 'en'; select.dispatchEvent(new Event('change'));
        await wait(async () => window.DeckI18n.getLanguage() === 'en' && (await deck.settingsGet()).language === 'en', 'English restored');
      })()`);
      console.log('Detached Workspace controls translate in tr/en; renderer reload restores saved Turkish locale');
      assert.ok(BrowserWindow.getAllWindows().every((w) => !w.isVisible()));
      BrowserWindow.getAllWindows().forEach((w) => w.destroy()); // main's close handler stops the fake bridge
      app.exit(0);
    } catch (e) { console.error(e.stack); BrowserWindow.getAllWindows().forEach((w) => w.destroy()); app.exit(1); }
  });
});
require("../main/main");
app.setPath("userData", path.join(dir, "profile")); // main's fixture profile is replaced with this run's own folder
