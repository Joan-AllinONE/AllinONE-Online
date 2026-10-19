/* tools/test-word-skill.js
 * 在 Node 里用最小 DOM 桩跑一遍「每日单词」技能，验证三件事：
 *   1. 工具栏按钮能打开面板（不再 ReferenceError）
 *   2. 点桌宠会弹出单词；定时按设定间隔重复
 *   3. 每日数量 / 出现间隔可改并立即生效
 * 运行： node tools/test-word-skill.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

/* ---------------- 最小 DOM 桩 ---------------- */
class El {
  constructor(tag) {
    this.tagName = tag; this.children = []; this._cls = new Set();
    this.attrs = {}; this._q = {}; this._html = ''; this.parentNode = null; this._ev = {};
    const self = this;
    this.classList = {
      add: c => self._cls.add(c),
      remove: c => self._cls.delete(c),
      contains: c => self._cls.has(c),
      toggle: (c, f) => (f ? self._cls.add(c) : self._cls.delete(c))
    };
  }
  get className() { return Array.from(this._cls).join(' '); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); if (v === '') { this.children = []; this._q = {}; } }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this); }
  addEventListener(t, f) { (this._ev[t] = this._ev[t] || []).push(f); }
  dispatch(type, target) {
    const ev = { type: type, target: target || this, stopPropagation() {}, preventDefault() {} };
    (this._ev[type] || []).slice().forEach(f => f(ev));
  }
  _find(sel) {
    if (sel.charAt(0) === '.') {
      const c = sel.slice(1);
      for (const ch of this.children) {
        if (ch._cls.has(c)) return ch;
        const d = ch._find(sel);
        if (d) return d;
      }
    }
    return null;
  }
  querySelector(sel) {
    const found = this._find(sel);
    if (found) return found;
    if (!this._q[sel]) {
      const e = new El('div');
      e.className = sel.replace(/^\./, '');
      this.appendChild(e);
      this._q[sel] = e;
    }
    return this._q[sel];
  }
  querySelectorAll() { return []; }
}

const body = new El('body');
const document = {
  body: body,
  createElement: t => new El(t),
  getElementById: id => {
    const find = el => {
      for (const c of el.children) {
        if (c.attrs.id === id || c.id === id) return c;   // 代码用 el.id = 赋值，桩要认
        const d = find(c); if (d) return d;
      }
      return null;
    };
    return find(body);
  },
  querySelector: sel => body.querySelector(sel),
  addEventListener() {}
};

/* ---------------- 全局环境 ---------------- */
const store = {};
const localStorage = {
  getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};

const listeners = {};
const spoken = [];
const toasts = [];

const win = {
  localStorage,
  document,
  setTimeout, clearTimeout, setInterval, clearInterval,
  PetCore: {
    on: (e, f) => ((listeners[e] = listeners[e] || []).push(f)),
    off: (e, f) => { if (listeners[e]) listeners[e] = listeners[e].filter(x => x !== f); },
    emit: (e, p) => ((listeners[e] || []).slice().forEach(f => f(p))),
    getStats: () => ({ mood: 50, satiety: 50, energy: 50 }),
    setStat: () => {}, setAnimState: () => {}, getAnimState: () => 'idle'
  },
  SpeechSystem: {
    sayText: t => spoken.push(t),
    say: () => {},
    sayThrottled: () => {},
    getTtsEnabled: () => false
  },
  PetUI: { toast: t => toasts.push(t) },
  PetFX: { spawn: () => {} },
  PET_WORDLIST: [
    { w: 'apple', p: '/ˈæpl/', c: '苹果', e: 'I eat an apple.' },
    { w: 'brave', p: '/breɪv/', c: '勇敢的', e: 'Be brave.' },
    { w: 'coffee', p: '/ˈkɒfi/', c: '咖啡', e: 'A cup of coffee.' },
    { w: 'dream', p: '/driːm/', c: '梦想', e: 'Good dream.' },
    { w: 'earth', p: '/ɜːθ/', c: '地球', e: 'on earth' },
    { w: 'forest', p: '/ˈfɒrɪst/', c: '森林', e: 'in the forest' },
    { w: 'garden', p: '/ˈɡɑːdn/', c: '花园', e: 'a garden' },
    { w: 'honey', p: '/ˈhʌni/', c: '蜂蜜', e: 'sweet honey' },
    { w: 'island', p: '/ˈaɪlənd/', c: '岛屿', e: 'small island' },
    { w: 'journey', p: '/ˈdʒɜːni/', c: '旅程', e: 'a long journey' }
  ]
};
win.window = win;

const ctx = vm.createContext(win);
function load(f) { vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f }); }

/* 开启技能后再加载 */
store['desktoppet.skill.daily-word.enabled'] = 'true';
load('js/word-parser.js');
load('js/skills.js');
load('js/skills/skill-word.js');

/* ---------------- 断言 ---------------- */
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('\n【1】工具栏按钮 / 面板');
const buttons = win.PetSkills.getActionButtons();
const wordBtn = buttons.filter(b => b.skillId === 'daily-word')[0];
ok('每日单词已注册出工具栏按钮', !!wordBtn);
let clickErr = null;
try { wordBtn.onClick(); } catch (e) { clickErr = e; }
ok('点击按钮不报错（旧版这里 ReferenceError）', !clickErr, clickErr && clickErr.message);
const panelEl = document.getElementById('word-panel');
ok('面板已插入 DOM', !!panelEl);
ok('面板可见（无 hidden）', panelEl && !panelEl.classList.contains('hidden'));

console.log('\n【2】点击桌宠弹出单词');
const before = win.PetWord.getState();
win.PetCore.emit('pet:click');
const after = win.PetWord.getState();
ok('点击后已学数量 +1', after.shown === before.shown + 1, before.shown + ' → ' + after.shown);
ok('说出了单词气泡', spoken.length > 0 && /🔤|🔁/.test(spoken[spoken.length - 1]), spoken[spoken.length - 1]);
const n1 = spoken.length;
win.PetCore.emit('pet:click');   // 4 秒冷却内应被忽略
ok('4 秒冷却内重复点击被节流', spoken.length === n1);

console.log('\n【3】每日数量可设置');
ok('默认每日 3 个', win.PetWord.getCount() === 3, String(win.PetWord.getCount()));
win.PetWord.setCount(5);
ok('设为 5 后生效', win.PetWord.getCount() === 5);
ok('今日词表长度 = 5', win.PetWord.todayWords().length === 5, String(win.PetWord.todayWords().length));
win.PetWord.setCount(999);
ok('超范围被夹到 50', win.PetWord.getCount() === 50, String(win.PetWord.getCount()));
win.PetWord.setCount(3);
ok('改回 3', win.PetWord.getCount() === 3);

console.log('\n【4】出现间隔与复习模式');
ok('默认间隔 5 分钟', win.PetWord.getInterval() === 5, String(win.PetWord.getInterval()));
win.PetWord.setInterval(10);
ok('间隔可改为 10', win.PetWord.getInterval() === 10);
win.PetWord.setInterval(5);

win.PetWord.setCount(2);
let guard = 0;
while (win.PetWord.getState().shown < 2 && guard++ < 10) { win.PetWord.next(); }
ok('学完当天 2 个后进入已完成态', win.PetWord.getState().finished === true);
ok('teachNow 在新词教完后返回 null', win.PetWord.teachNow() === null);
const w = win.PetWord.next();
ok('新词教完仍可继续（复习模式）', !!w, w && w.w);
ok('复习标记出现在文案里', /🔁/.test(spoken[spoken.length - 1]), spoken[spoken.length - 1]);

console.log('\n【5】词库编辑');
win.PetWord.setList('zebra||斑马\nkiwi||猕猴桃');
ok('自定义词库生效', win.PetWord.getList().length === 2, String(win.PetWord.getList().length));

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n');
process.exit(fail ? 1 : 0);
