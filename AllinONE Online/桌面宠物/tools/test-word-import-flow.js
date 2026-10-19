/* tools/test-word-import-flow.js — 「吃下一份单词表」完整流程测试
 * 覆盖：解析预览 → 替换/追加 → 吃下动画 → 生成今天的单词
 * 运行： node tools/test-word-import-flow.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

/* ---- 最小 DOM 桩（与 test-word-skill.js 同款） ---- */
class El {
  constructor(t) {
    this.tagName = t; this.children = []; this._cls = new Set(); this.attrs = {}; this._q = {}; this._html = ''; this._ev = {}; this.style = {};
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
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this); }
  addEventListener(t, f) { (this._ev[t] = this._ev[t] || []).push(f); }
  dispatch(type, target) {
    const ev = { type, target: target || this, stopPropagation() {}, preventDefault() {} };
    (this._ev[type] || []).slice().forEach(f => f(ev));
  }
  _find(sel) {
    if (sel.charAt(0) !== '.') return null;
    for (const c of this.children) { if (c._cls.has(sel.slice(1))) return c; const d = c._find(sel); if (d) return d; }
    return null;
  }
  querySelector(sel) {
    const f = this._find(sel); if (f) return f;
    if (!this._q[sel]) { const e = new El('div'); e.className = sel.replace(/^\./, ''); this.appendChild(e); this._q[sel] = e; }
    return this._q[sel];
  }
  querySelectorAll() { return []; }
  click() { this.clicked = true; }
}
const body = new El('body');
const document = {
  body, createElement: t => new El(t), addEventListener() {},
  getElementById: id => {
    const find = el => {
      for (const c of el.children) { if (c.attrs.id === id || c.id === id) return c; const d = find(c); if (d) return d; }
      return null;
    };
    return find(body);
  },
  querySelector: sel => body.querySelector(sel)
};

const store = {};
const listeners = {};
const spoken = [];
const fed = [];
const toasts = [];
const win = {
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
  document, setTimeout, clearTimeout, setInterval, clearInterval,
  PetCore: {
    on: (e, f) => ((listeners[e] = listeners[e] || []).push(f)),
    off: () => {}, emit: () => {},
    feed: e => { fed.push(e); return true; },
    getStats: () => ({ satiety: 50, mood: 50, energy: 50 }),
    setStat: () => {}, setAnimState: () => {}
  },
  SpeechSystem: { sayText: t => spoken.push(t), say: () => {}, sayThrottled: () => {}, getTtsEnabled: () => false },
  PetUI: { toast: t => toasts.push(t) },
  PetFX: { spawn: () => {} },
  PET_WORDLIST: [{ w: 'apple', c: '苹果' }, { w: 'brave', c: '勇敢的' }, { w: 'coffee', c: '咖啡' }]
};
win.window = win;
const ctx = vm.createContext(win);
const load = f => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });

store['desktoppet.skill.daily-word.enabled'] = 'true';
load('js/word-parser.js');
load('js/skills.js');
load('js/skills/skill-word.js');
const W = win.PetWord;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('\n【1】喂进一份 txt（宽松格式）');
W.importText('1. zebra 斑马\n2. kiwi 猕猴桃\n3. lemon 柠檬', '水果表.txt');
const p = document.getElementById('word-panel');
const imp = p.querySelector('.word-import');
ok('导入预览区块已展开', !imp.classList.contains('hidden'));
ok('预览摘要里写了认出的数量', /3/.test(p.querySelector('.word-import-sum').innerHTML), p.querySelector('.word-import-sum').innerHTML);
ok('预览里带上了文件名', /水果表\.txt/.test(p.querySelector('.word-import-sum').innerHTML));
ok('此时还没写进词库（等确认）', W.getList().length === 3, String(W.getList().length));

console.log('\n【2】确认「替换」→ 吃下 + 生成今天的单词');
W.applyImport('replace');
ok('词库已被替换', W.getList().length === 3 && W.getList()[0].w === 'zebra', JSON.stringify(W.getList()[0]));
ok('记录了词库来源', W.getSource() === '水果表.txt', W.getSource());
ok('触发了喂食动画（一张纸掉下来）', fed.length === 1 && fed[0] === '📄', JSON.stringify(fed));
ok('宠物说了「吃掉」的话', spoken.some(s => /吃掉|啊呜/.test(s)), spoken.join(' | '));
ok('今天的单词表已更新', W.todayWords().map(w => w.w).join(',') === 'zebra,kiwi,lemon', W.todayWords().map(w => w.w).join(','));

console.log('\n【3】等 6 秒看「生成今天要学的单词」有没有发生');
setTimeout(function () {
  const hasTarget = spoken.some(s => /今天要学的是/.test(s));
  ok('报出了今天要学的单词', hasTarget, spoken.join(' | '));
  ok('接着弹出了第一个单词', spoken.some(s => /zebra/.test(s)), spoken.join(' | '));
  ok('toast 里给了今日清单', toasts.some(t => /今日单词/.test(t)), toasts.join(' | '));

  console.log('\n【4】追加模式');
  const beforeLen = W.getList().length;
  W.importText('mango 芒果\nzebra 斑马', '加餐.txt');
  W.applyImport('append');
  ok('追加后数量增加', W.getList().length === beforeLen + 1, String(W.getList().length));
  ok('追加时自动去重（zebra 没重复）', W.getList().filter(w => w.w === 'zebra').length === 1);
  ok('追加后来源更新', W.getSource() === '加餐.txt', W.getSource());

  console.log('\n【5】认不出来的文件要拦住');
  const n1 = W.getList().length;
  W.importText('随便一段中文，没有单词', '乱码.txt');
  ok('识别失败时不改词库', W.getList().length === n1);
  const sum = p.querySelector('.word-import-sum').innerHTML;
  ok('预览里给了失败提示', /😿|一个单词都没认出来/.test(sum), sum);
  W.applyImport('replace');
  ok('失败后点确认不会误改词库', W.getList().length === n1, String(W.getList().length));

  console.log('\n【6】换一组');
  W.setCount(2);
  W.reroll();
  ok('换一组后今天的词仍是设定数量', W.todayWords().length === 2, String(W.todayWords().length));

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n');
  process.exit(fail ? 1 : 0);
}, 6200);
