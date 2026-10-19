/* tools/test-word-timer.js — 验证「定时重复弹出」真的会触发（真实计时，约 70 秒）
 * 运行： node tools/test-word-timer.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

class El {
  constructor(t) {
    this.tagName = t; this.children = []; this._cls = new Set(); this.attrs = {}; this._q = {}; this._html = ''; this._ev = {};
    const s = this;
    this.classList = { add: c => s._cls.add(c), remove: c => s._cls.delete(c), contains: c => s._cls.has(c), toggle: (c, f) => (f ? s._cls.add(c) : s._cls.delete(c)) };
  }
  get className() { return Array.from(this._cls).join(' '); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); if (v === '') { this.children = []; this._q = {}; } }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  remove() {}
  addEventListener() {}
  querySelector(sel) {
    const f = this._find(sel); if (f) return f;
    if (!this._q[sel]) { const e = new El('div'); e.className = sel.replace(/^\./, ''); this.appendChild(e); this._q[sel] = e; }
    return this._q[sel];
  }
  _find(sel) {
    if (sel.charAt(0) !== '.') return null;
    for (const c of this.children) { if (c._cls.has(sel.slice(1))) return c; const d = c._find(sel); if (d) return d; }
    return null;
  }
  querySelectorAll() { return []; }
}
const body = new El('body');
const document = { body, createElement: t => new El(t), getElementById: () => null, addEventListener() {} };
const store = {};
const listeners = {};
let count = 0;
const win = {
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
  document, setTimeout, clearTimeout, setInterval, clearInterval,
  PetCore: { on: (e, f) => ((listeners[e] = listeners[e] || []).push(f)), off: () => {}, emit: () => {}, getStats: () => ({}), setStat: () => {}, setAnimState: () => {} },
  SpeechSystem: { sayText: () => { count++; }, say: () => {}, sayThrottled: () => {}, getTtsEnabled: () => false },
  PetUI: { toast: () => {} }, PetFX: { spawn: () => {} },
  PET_WORDLIST: [{ w: 'a' }, { w: 'b' }, { w: 'c' }, { w: 'd' }, { w: 'e' }]
};
win.window = win;
const c = vm.createContext(win);
const load = f => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), c, { filename: f });

store['desktoppet.skill.daily-word.enabled'] = 'true';
store['desktoppet.skill.daily-word.interval'] = '1';   // 1 分钟，方便观测
load('js/skills.js');
load('js/skills/skill-word.js');

console.log('启动后立刻弹词次数：' + count + '（应为 1，启动给第一个）');
const start = Date.now();
const t = setInterval(() => {
  const el = Math.round((Date.now() - start) / 1000);
  if (el >= 65) {
    clearInterval(t);
    console.log('65 秒后累计弹词次数：' + count + '（1 分钟间隔下应为 2）');
    console.log(count >= 2 ? '✅ 定时重复生效' : '❌ 定时器没有按间隔触发');
    process.exit(count >= 2 ? 0 : 1);
  }
}, 1000);
