/* ==========================================================
 * 技能：每日单词
 *
 * 三项设定（都可在「🔤 今日单词」面板里改，存 localStorage）
 *   · 每日数量 —— 每天学几个新单词（默认 3，可选 3/5/10/20 或自定义 1-50）
 *   · 出现间隔 —— 自动弹出间隔（默认 5 分钟，可选 1/3/5/10/15/30/60）
 *   · 点击弹出 —— 点一下桌宠就跳出一个单词，像对话一样（4 秒节流，防刷屏）
 *
 * 触发方式：
 *   1) 定时：每 interval 分钟自动出现一个
 *   2) 点击：点桌宠立刻出现一个
 *   3) 面板：工具栏 🔤 → 「下一个」
 *   当天新词背完后进入「复习模式」，继续按间隔循环复习今天的词，不再空窗。
 *
 * 词库来源：
 *   1) 内置 60 词（js/wordlist.js）
 *   2) 面板里粘贴
 *   3) **吃一份单词表文件**（txt / csv / tsv / json）—— 面板「📥 吃一份单词表」
 *      或直接把文件拖到宠物身上，它会「啊呜」一口吞掉，然后吐出今天的单词
 *      格式由 js/word-parser.js 自动嗅探：竖线 / 逗号 / 制表符 / 空格 / 冒号 /
 *      纯单词 / 带序号 / JSON 都认，列顺序打乱也能猜出来
 *
 * 注意：
 *   actions 里的 onClick 只能访问「注册作用域」的变量（openPanel 定义在 setup
 *   内部，直接引用会 ReferenceError），所以统一走模块级 API 变量转发。
 * ========================================================== */
let PET_WORD_API = null;          // 模块级句柄：供工具栏按钮 / 外部调用

PetSkills.register({
  id: 'daily-word',
  name: '每日单词',
  description: '每天学几个单词可自己设定；定时弹出，点桌宠也会跳出一个；还能吃下一份 txt/csv 单词表。',
  icon: '🔤',
  defaultEnabled: false,          // 可选项：默认不加载

  actions: [
    {
      id: 'open', label: '今日单词', icon: '🔤',
      onClick: function () { if (PET_WORD_API) PET_WORD_API.openPanel(); }
    },
    {
      id: 'import', label: '吃一份单词表', icon: '📥',
      onClick: function () { if (PET_WORD_API) PET_WORD_API.pickFile(); }
    }
  ],

  setup: function (ctx) {
    const PANEL_ID = 'word-panel';
    const DEFAULTS = { count: 3, interval: 5 };   // 每日数量 / 自动间隔（分钟）
    const COUNT_PRESETS = [3, 5, 10, 20];
    const INTERVAL_PRESETS = [1, 3, 5, 10, 15, 30, 60];
    const CLICK_COOLDOWN = 4000;  // 点击触发的最小间隔（毫秒）

    let timer = null;
    let dayTimer = null;
    let panel = null;
    let lastPresentAt = 0;

    const st = {
      day: '', shown: 0, startIdx: 0, lastAt: 0,
      days: 0, total: 0, reviewIdx: 0, finished: false
    };

    /* ---------------- 设置（每日数量 / 出现间隔） ---------------- */
    function clamp(n, lo, hi, fb) {
      /* 注意：必须先排除 null/undefined —— Number(null) 是 0，
         不排除的话「没存过」会被当成 0 再夹到下限，默认值就失效了 */
      if (n === null || n === undefined || n === '') return fb;
      n = Number(n);
      if (!isFinite(n)) return fb;
      return Math.min(hi, Math.max(lo, Math.round(n)));
    }
    function getCount() { return clamp(ctx.storageGet('count'), 1, 50, DEFAULTS.count); }
    function setCount(n) {
      n = clamp(n, 1, 50, DEFAULTS.count);
      ctx.storageSet('count', n);
      st.shown = Math.min(st.shown, n);
      saveState(); ensureDay(); renderPanel(); schedule(false);
      return n;
    }
    function getInterval() { return clamp(ctx.storageGet('interval'), 1, 240, DEFAULTS.interval); }
    function setIntervalMin(n) {
      n = clamp(n, 1, 240, DEFAULTS.interval);
      ctx.storageSet('interval', n);
      renderPanel(); schedule(false);
      return n;
    }

    /* ---------------- 词库 ---------------- */
    function defaultList() {
      return (window.PET_WORDLIST && window.PET_WORDLIST.length) ? window.PET_WORDLIST : [];
    }
    function getList() {
      const custom = ctx.storageGet('list');
      if (Array.isArray(custom) && custom.length) return custom;
      return defaultList();
    }
    /* 粘贴框也走同一个解析器，所以宽松格式（空格/冒号/带序号）同样能粘进来 */
    function parseList(text) {
      if (window.WordParser) return window.WordParser.parse(String(text || '')).words;
      const out = [];
      String(text || '').split(/\r?\n/).forEach(function (line) {
        line = line.trim();
        if (!line || line.charAt(0) === '#') return;
        const p = line.split('|').map(function (s) { return s.trim(); });
        if (!p[0]) return;
        out.push({ w: p[0], p: p[1] || '', c: p[2] || '', e: p[3] || '' });
      });
      return out;
    }
    function toText(list) {
      if (window.WordParser) return window.WordParser.toText(list);
      return (list || []).map(function (x) {
        return [x.w, x.p || '', x.c || '', x.e || ''].join('|');
      }).join('\n');
    }

    /* ---------------- 状态 ---------------- */
    function todayKey() {
      const d = new Date();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return d.getFullYear() + '-' + m + '-' + day;
    }
    function dayNumber() {
      return Math.floor(new Date(new Date().toDateString()).getTime() / 86400000);
    }
    function loadState() {
      st.day = ctx.storageGet('day') || '';
      st.shown = Number(ctx.storageGet('shown')) || 0;
      st.startIdx = Number(ctx.storageGet('startIdx')) || 0;
      st.lastAt = Number(ctx.storageGet('lastAt')) || 0;
      st.days = Number(ctx.storageGet('days')) || 0;
      st.total = Number(ctx.storageGet('total')) || 0;
      st.reviewIdx = Number(ctx.storageGet('reviewIdx')) || 0;
      st.finished = !!ctx.storageGet('finished');
    }
    function saveState() {
      ctx.storageSet('day', st.day);
      ctx.storageSet('shown', st.shown);
      ctx.storageSet('startIdx', st.startIdx);
      ctx.storageSet('lastAt', st.lastAt);
      ctx.storageSet('days', st.days);
      ctx.storageSet('total', st.total);
      ctx.storageSet('reviewIdx', st.reviewIdx);
      ctx.storageSet('finished', st.finished);
    }
    function ensureDay() {
      const list = getList();
      if (!list.length) return false;
      const t = todayKey();
      if (st.day !== t) {
        st.day = t;
        st.shown = 0;
        st.lastAt = 0;
        st.reviewIdx = 0;
        st.finished = false;
        /* 每天从词库不同位置开始，走完自动回卷 */
        st.startIdx = (dayNumber() * getCount()) % list.length;
        saveState();
      }
      return true;
    }
    function count() { return getCount(); }
    function todayWords() {
      const list = getList();
      if (!list.length) return [];
      const n = Math.min(count(), list.length);
      const out = [];
      for (let i = 0; i < n; i++) out.push(list[(st.startIdx + i) % list.length]);
      return out;
    }

    /* ---------------- 展示 ---------------- */
    function speakWord(w, review) {
      const text = (review ? '🔁 ' : '🔤 ') + w.w + (w.p ? '  ' + w.p : '') + (w.c ? '  ' + w.c : '');
      if (window.SpeechSystem) window.SpeechSystem.sayText(text);
      /* 中文嗓音读英语很别扭：气泡照常显示，朗读改成英文发音 */
      try {
        if (window.SpeechSystem && window.SpeechSystem.getTtsEnabled() && window.speechSynthesis) {
          window.speechSynthesis.cancel();
          const u = new SpeechSynthesisUtterance(w.w);
          u.lang = 'en-US';
          u.rate = 0.85;
          window.speechSynthesis.speak(u);
        }
      } catch (e) { /* 发音失败不影响背单词 */ }
    }

    function present(w, review, order) {
      lastPresentAt = Date.now();
      speakWord(w, review);
      const c = count();
      const label = review
        ? '🔁 复习 ' + ((order % c) + 1) + '/' + c
        : '🔤 今日单词 ' + (order + 1) + '/' + c;
      if (window.PetUI) window.PetUI.toast(label + '：' + w.w + ' ' + (w.c || ''));
      if (window.PetFX) window.PetFX.spawn('star', review ? 2 : 3);
      renderPanel();
    }

    function finishDay() {
      st.finished = true;
      st.days++;
      saveState();
      if (window.PetUI) window.PetUI.toast('🎉 今天的 ' + count() + ' 个单词学完啦！累计 ' + st.days + ' 天');
      if (window.PetFX) window.PetFX.spawn('star', 6);

      /* 代码段 D：背完一天掉落一个可提取道具（非平台环境自动跳过） */
      if (window.AllinONEHarvest) {
        window.AllinONEHarvest.spawn('单词星', 'boost_mood', { amount: 10 }, '完成一天单词学习获得，可提取为平台凭证');
      }
      /* 代码段 E：行为奖励上报（非平台环境自动跳过） */
      if (window.AllinONE_Reward) {
        window.AllinONE_Reward.report('LEVEL_COMPLETE', { day: st.days, total: st.total });
        if (st.days === 7 || st.days === 30) {
          window.AllinONE_Reward.report('ACHIEVEMENT_UNLOCK', { id: 'word-days-' + st.days, total: st.total });
        }
      }
    }

    /* 取下一个该出现的词：先新词，背完转复习（循环今天这几个） */
    function takeWord() {
      const list = getList();
      if (!list.length) return null;
      const c = count();
      if (st.shown < c) {
        const w = list[(st.startIdx + st.shown) % list.length];
        const order = st.shown;
        st.shown++; st.total++;
        return { word: w, review: false, order: order };
      }
      const words = todayWords();
      if (!words.length) return null;
      const w = words[st.reviewIdx % words.length];
      const order = st.reviewIdx;
      st.reviewIdx++;
      return { word: w, review: true, order: order };
    }

    /* reason: 'timer' | 'click' | 'manual' | 'item' */
    function showNext(reason) {
      if (!ensureDay()) return null;
      const taken = takeWord();
      if (!taken) return null;

      st.lastAt = Date.now();
      const wasNew = !taken.review;
      saveState();

      present(taken.word, taken.review, taken.order);

      if (wasNew && st.shown >= count() && !st.finished) finishDay();
      schedule(false);
      renderPanel();
      return taken.word;
    }

    function schedule(immediate) {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!getList().length) return;
      const iv = getInterval() * 60000;
      let wait;
      if (immediate) wait = 0;
      else if (st.lastAt) wait = Math.max(0, st.lastAt + iv - Date.now());
      else wait = iv;                    // 还没出过词：等一个完整间隔
      timer = setTimeout(function () { showNext('timer'); }, wait);
    }

    /* ---------------- 吃下一份单词表 ---------------- */
    /* 说明：桌面透明穿透模式下窗口收不到拖放事件，所以「面板按钮选文件」是主路径，
       拖到宠物身上只在浏览器模式/Electron 非穿透区域有效，属于锦上添花。 */
    const eatTimers = [];
    const dropCleanups = [];
    let pendingImport = null;
    let fileInput = null;

    function getSource() { return ctx.storageGet('source') || ''; }
    function clearEatTimers() {
      while (eatTimers.length) clearTimeout(eatTimers.pop());
    }
    function isTextFile(f) {
      if (!f) return false;
      if (f.type && /^text\//.test(f.type)) return true;
      return /\.(txt|csv|tsv|json|md|dic)$/i.test(f.name || '');
    }

    function readFile(file, cb) {
      if (!file) return;
      if (file.size && file.size > 3 * 1024 * 1024) {
        if (window.PetUI) window.PetUI.toast('这份单词表太大啦（>3MB），先拆小一点');
        return;
      }
      try {
        const fr = new FileReader();
        fr.onload = function () { cb(String(fr.result || ''), file.name || ''); };
        fr.onerror = function () { if (window.PetUI) window.PetUI.toast('文件读不出来，换一个试试'); };
        fr.readAsText(file, 'utf-8');
      } catch (e) {
        if (window.PetUI) window.PetUI.toast('这个浏览器不支持读文件');
      }
    }

    function ensureFileInput() {
      if (fileInput) return fileInput;
      fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = '.txt,.csv,.tsv,.json,.md,.dic,text/plain';
      fileInput.style.display = 'none';
      fileInput.addEventListener('change', function () {
        const f = fileInput.files && fileInput.files[0];
        fileInput.value = '';                       // 允许连续选同一个文件
        if (!f) return;
        if (!isTextFile(f)) {
          if (window.PetUI) window.PetUI.toast('我只吃文本文件：txt / csv / tsv / json');
          return;
        }
        readFile(f, function (text, name) { openPanel(); previewImport(text, name); });
      });
      document.body.appendChild(fileInput);
      return fileInput;
    }
    function pickFile() { ensureFileInput().click(); }

    /* 解析结果先给用户看一眼，确认后再写进词库 */
    function previewImport(text, name) {
      if (!window.WordParser) {
        if (window.PetUI) window.PetUI.toast('解析器没加载，检查 index.html 里有没有 word-parser.js');
        return;
      }
      const r = window.WordParser.parse(text, name);
      r.fileName = name || '';
      pendingImport = r.ok ? r : null;
      openPanel();
      renderImportPreview(r);
      if (!r.ok && window.PetUI) window.PetUI.toast('😿 ' + r.message);
    }

    function applyImport(mode) {
      const r = pendingImport;
      if (!r || !r.ok) return;
      let list;
      if (mode === 'append') {
        const cur = getList();
        const seen = {};
        cur.forEach(function (w) { seen[w.w.toLowerCase()] = 1; });
        const add = r.words.filter(function (w) { return !seen[w.w.toLowerCase()]; });
        list = cur.concat(add);
      } else {
        list = r.words;
      }
      ctx.storageSet('list', list);
      ctx.storageSet('source', r.fileName || '粘贴的词库');

      if (mode === 'replace') {
        st.startIdx = 0; st.shown = 0; st.reviewIdx = 0; st.finished = false;
      }
      st.day = todayKey();
      st.lastAt = 0;
      saveState();
      pendingImport = null;
      renderPanel();
      eatAndStart(list.length, mode === 'append' ? 'append' : 'replace');
    }

    /* 「吃下」的仪式感：一张纸从天而降 → 宠物张嘴接住 → 报出今天的单词 */
    function eatAndStart(total, mode) {
      clearEatTimers();
      const n = total;
      ctx.feed('📄');
      ctx.sayText('📄 啊呜——' + (mode === 'append' ? '又加进 ' : '我吃掉 ') + n + ' 个单词啦！');
      if (window.PetFX) window.PetFX.spawn('star', 6);

      eatTimers.push(setTimeout(function () {
        const ws = todayWords();
        if (!ws.length) return;
        const names = ws.map(function (w) { return w.w; }).join('、');
        ctx.sayText('今天要学的是：' + names);
        if (window.PetUI) window.PetUI.toast('🎯 今日单词：' + ws.map(function (w) { return w.w; }).join(' / '));
      }, 2400));

      eatTimers.push(setTimeout(function () {
        schedule(false);
        showNext('manual');
      }, 5400));
    }

    /* 换一组：今天的词重新抽 */
    function reroll() {
      const list = getList();
      if (!list.length) return;
      st.startIdx = Math.floor(Math.random() * list.length);
      st.shown = 0; st.reviewIdx = 0; st.finished = false;
      st.day = todayKey(); st.lastAt = 0;
      saveState();
      renderPanel();
      if (window.PetUI) window.PetUI.toast('🎲 换了一批：' + todayWords().map(function (w) { return w.w; }).join(' / '));
      schedule(false);
    }

    /* 导出当前词库为 txt */
    function exportList() {
      const list = getList();
      if (!list.length) { if (window.PetUI) window.PetUI.toast('词库是空的，没什么可导出'); return; }
      try {
        const blob = new Blob(['\uFEFF' + toText(list)], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = '单词表-' + todayKey() + '.txt';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        if (window.PetUI) window.PetUI.toast('📤 已导出 ' + list.length + ' 个单词');
      } catch (e) {
        if (window.PetUI) window.PetUI.toast('导出失败，浏览器不允许保存文件');
      }
    }

    function bindDrop(el) {
      if (!el || !el.addEventListener) return;
      const over = function (e) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        el.classList.add('word-drop');
      };
      const leave = function () { el.classList.remove('word-drop'); };
      const drop = function (e) {
        e.preventDefault();
        el.classList.remove('word-drop');
        const dt = e.dataTransfer;
        const f = dt && dt.files && dt.files[0];
        if (!f) return;
        if (!isTextFile(f)) {
          if (window.PetUI) window.PetUI.toast('我只吃文本文件哦（txt / csv / json）');
          return;
        }
        readFile(f, function (text, name) { previewImport(text, name); });
      };
      el.addEventListener('dragover', over);
      el.addEventListener('dragleave', leave);
      el.addEventListener('drop', drop);
      dropCleanups.push(function () {
        el.removeEventListener('dragover', over);
        el.removeEventListener('dragleave', leave);
        el.removeEventListener('drop', drop);
        el.classList.remove('word-drop');
      });
    }

    /* ---------------- 面板 ---------------- */
    function countChipsHtml() {
      const cur = getCount();
      let h = '';
      COUNT_PRESETS.forEach(function (n) {
        h += '<button data-count="' + n + '" class="word-chip' + (n === cur ? ' on' : '') + '">' + n + '</button>';
      });
      h += '<input class="word-num" type="number" min="1" max="50" value="' + cur + '" aria-label="自定义每日单词数量">';
      return h;
    }
    function intervalOptionsHtml() {
      const cur = getInterval();
      let h = '';
      INTERVAL_PRESETS.forEach(function (n) {
        h += '<option value="' + n + '"' + (n === cur ? ' selected' : '') + '>' + n + ' 分钟</option>';
      });
      if (INTERVAL_PRESETS.indexOf(cur) < 0) {
        h += '<option value="' + cur + '" selected>' + cur + ' 分钟</option>';
      }
      return h;
    }

    function buildPanel() {
      const exist = document.getElementById(PANEL_ID);
      if (exist) return exist;

      panel = document.createElement('div');
      panel.id = PANEL_ID;
      panel.className = 'word-panel hidden';
      panel.innerHTML =
        '<header class="word-head">' +
          '<h3>🔤 今日单词</h3>' +
          '<button class="word-close" aria-label="关闭">×</button>' +
        '</header>' +
        '<div class="word-body">' +
          '<div class="word-source"></div>' +
          '<div class="word-progress"></div>' +
          '<div class="word-cards"></div>' +
          '<div class="word-import hidden">' +
            '<p class="word-import-sum"></p>' +
            '<div class="word-import-sample"></div>' +
            '<div class="word-actions">' +
              '<button data-act="do-replace" class="primary">🐟 吃掉并替换</button>' +
              '<button data-act="do-append">➕ 追加到现有</button>' +
              '<button data-act="do-cancel">取消</button>' +
            '</div>' +
          '</div>' +
          '<div class="word-settings">' +
            '<div class="word-setrow">' +
              '<span class="word-setlabel">每日数量</span>' +
              '<span class="word-chips">' + countChipsHtml() + '</span>' +
            '</div>' +
            '<div class="word-setrow">' +
              '<span class="word-setlabel">出现间隔</span>' +
              '<select class="word-interval">' + intervalOptionsHtml() + '</select>' +
            '</div>' +
            '<p class="word-tip">设定后立刻生效。点一下桌宠也会跳出一个单词（4 秒内不重复）。</p>' +
          '</div>' +
          '<div class="word-editor hidden">' +
            '<p class="word-tip">每行一个，<code>|</code> 分隔：单词|音标|中文|例句（后三项可省）<br>' +
            '也认「单词 中文」「单词: 中文」「1. 单词 中文」等写法。</p>' +
            '<textarea class="word-textarea" spellcheck="false"></textarea>' +
            '<div class="word-actions">' +
              '<button data-act="save" class="primary">保存词库</button>' +
              '<button data-act="reset">恢复默认</button>' +
              '<button data-act="cancel">取消</button>' +
            '</div>' +
          '</div>' +
          '<div class="word-actions word-main">' +
            '<button data-act="import" class="primary">📥 吃一份单词表</button>' +
            '<button data-act="reroll">🎲 换一组</button>' +
            '<button data-act="next">🔤 下一个</button>' +
            '<button data-act="teach">🔊 再读一遍</button>' +
            '<button data-act="edit">📖 编辑词库</button>' +
            '<button data-act="export">📤 导出</button>' +
          '</div>' +
          '<p class="word-tip">把 txt / csv / json 单词表拖到宠物身上也能直接喂给它' +
          '（桌面透明模式下请用上面的按钮）。</p>' +
        '</div>';

      panel.addEventListener('click', function (e) {
        e.stopPropagation();
        const t = e.target;
        const act = t.getAttribute && t.getAttribute('data-act');
        const cnt = t.getAttribute && t.getAttribute('data-count');

        if (cnt) { setCount(cnt); return; }
        if (t.classList && t.classList.contains('word-close')) { closePanel(); return; }
        if (!act) return;

        if (act === 'next') {
          showNext('manual');
        } else if (act === 'import') {
          pickFile();
        } else if (act === 'reroll') {
          reroll();
        } else if (act === 'export') {
          exportList();
        } else if (act === 'do-replace') {
          applyImport('replace');
        } else if (act === 'do-append') {
          applyImport('append');
        } else if (act === 'do-cancel') {
          pendingImport = null;
          panel.querySelector('.word-import').classList.add('hidden');
        } else if (act === 'teach') {
          const c = count();
          const idx = st.shown < c ? st.shown : (st.reviewIdx > 0 ? st.reviewIdx - 1 : 0);
          const w = todayWords()[idx % Math.max(1, todayWords().length)];
          if (w) speakWord(w, st.shown >= c);
        } else if (act === 'edit') {
          panel.querySelector('.word-textarea').value = toText(getList());
          panel.querySelector('.word-editor').classList.remove('hidden');
        } else if (act === 'cancel') {
          panel.querySelector('.word-editor').classList.add('hidden');
        } else if (act === 'reset') {
          ctx.storageSet('list', null);
          ctx.storageSet('source', null);
          ensureDay(); renderPanel();
          panel.querySelector('.word-editor').classList.add('hidden');
          if (window.PetUI) window.PetUI.toast('已恢复默认词库');
        } else if (act === 'save') {
          const parsed = parseList(panel.querySelector('.word-textarea').value);
          if (!parsed.length) {
            if (window.PetUI) window.PetUI.toast('词库是空的，至少写一行吧');
            return;
          }
          ctx.storageSet('list', parsed);
          ctx.storageSet('source', '粘贴的词库');
          st.shown = Math.min(st.shown, count());
          ensureDay(); renderPanel();
          panel.querySelector('.word-editor').classList.add('hidden');
          if (window.PetUI) window.PetUI.toast('词库已保存，共 ' + parsed.length + ' 个单词');
        }
      });

      /* 数量输入框：失焦或回车生效 */
      panel.addEventListener('change', function (e) {
        if (e.target.classList && e.target.classList.contains('word-num')) {
          setCount(e.target.value);
        } else if (e.target.classList && e.target.classList.contains('word-interval')) {
          setIntervalMin(e.target.value);
        }
      });
      panel.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('word-num')) {
          e.preventDefault();
          setCount(e.target.value);
        }
      });

      document.body.appendChild(panel);
      bindDrop(panel);
      return panel;
    }

    /* 导入预览：把识别结果摊开给用户看，避免「吃下去才发现认错了」 */
    function renderImportPreview(r) {
      const p = panel || document.getElementById(PANEL_ID);
      if (!p) return;
      const box = p.querySelector('.word-import');
      const sum = p.querySelector('.word-import-sum');
      const sample = p.querySelector('.word-import-sample');
      if (!box || !sum || !sample) return;
      box.classList.remove('hidden');

      const repBtn = box.querySelector('[data-act="do-replace"]');
      const appBtn = box.querySelector('[data-act="do-append"]');
      const showBtns = function (v) {
        if (repBtn && repBtn.style) repBtn.style.display = v ? '' : 'none';
        if (appBtn && appBtn.style) appBtn.style.display = v ? '' : 'none';
      };
      if (!r.ok || !repBtn || !appBtn) {
        sum.innerHTML = '😿 ' + escapeHtml(r.message || '没认出任何单词');
        sample.innerHTML = '';
        showBtns(false);
        return;
      }
      showBtns(true);

      let s = '📄 <b>' + escapeHtml(r.fileName || '这份单词表') + '</b>：认出 <b>' + r.count +
              '</b> 个单词 · ' + escapeHtml(r.formatLabel);
      const notes = [];
      if (r.dup) notes.push('合并重复 ' + r.dup + ' 个');
      if (r.skipped) notes.push('跳过 ' + r.skipped + ' 行看不懂的');
      if (r.truncated) notes.push('太多了，只吃下前 ' + r.count + ' 个');
      if (notes.length) s += '<br><span class="word-note">（' + notes.join('；') + '）</span>';
      sum.innerHTML = s;

      sample.innerHTML = '';
      r.sample.forEach(function (w) {
        const d = document.createElement('div');
        d.className = 'word-import-row';
        d.textContent = w.w + (w.p ? '  ' + w.p : '') + (w.c ? '  ' + w.c : '');
        sample.appendChild(d);
      });
      if (r.errors.length) {
        const d = document.createElement('div');
        d.className = 'word-note';
        d.textContent = r.errors.join('；');
        sample.appendChild(d);
      }
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    function renderPanel() {
      const p = panel || document.getElementById(PANEL_ID);
      if (!p) return;
      const box = p.querySelector('.word-cards');
      const prog = p.querySelector('.word-progress');
      if (!box) return;

      const c = count();
      const words = todayWords();

      /* 当前词库来源 */
      const src = p.querySelector('.word-source');
      if (src) {
        const name = getSource();
        src.innerHTML = '📚 当前词库：' + escapeHtml(name || '内置词库') +
          '（' + getList().length + ' 词）';
      }

      if (prog) {
        prog.textContent = st.finished
          ? '✅ 今天的新词已学完（' + c + '/' + c + '），继续复习中 · 累计 ' + st.days + ' 天'
          : '今日进度 ' + st.shown + '/' + c + ' · 累计学习 ' + st.total + ' 词';
      }

      /* 设置区与当前值保持同步 */
      const chips = p.querySelector('.word-chips');
      if (chips) chips.innerHTML = countChipsHtml();
      const sel = p.querySelector('.word-interval');
      if (sel) sel.value = String(getInterval());

      if (!words.length) {
        box.innerHTML = '<p class="word-tip">词库为空，点「编辑词库」添加单词。</p>';
        return;
      }
      box.innerHTML = '';
      words.forEach(function (w, i) {
        const done = i < st.shown;
        const row = document.createElement('div');
        row.className = 'word-card' + (done ? ' done' : '');
        row.innerHTML =
          '<div class="word-top"><span class="word-en">' + w.w + '</span>' +
          '<span class="word-ph">' + (w.p || '') + '</span>' +
          '<span class="word-flag">' + (done ? '✅' : '○') + '</span></div>' +
          '<div class="word-cn">' + (w.c || '') + '</div>' +
          (w.e ? '<div class="word-eg">' + w.e + '</div>' : '');
        row.addEventListener('click', function (ev) { ev.stopPropagation(); speakWord(w, false); });
        box.appendChild(row);
      });
    }

    function openPanel() {
      ensureDay();
      const p = buildPanel();
      renderPanel();
      p.classList.remove('hidden');
    }
    function closePanel() {
      const p = panel || document.getElementById(PANEL_ID);
      if (p) p.classList.add('hidden');
    }

    /* ---------------- 点击桌宠 → 弹出单词（对话式） ---------------- */
    ctx.on('pet:click', function () {
      if (Date.now() - lastPresentAt < CLICK_COOLDOWN) return;
      showNext('click');
    });

    /* ---------------- 对外 API（供道具效果 teach_word / 平台扩展调用） ---------------- */
    PET_WORD_API = window.PetWord = {
      openPanel: openPanel,
      closePanel: closePanel,
      pickFile: pickFile,
      /* 直接喂一段文本（平台扩展/脚本可用） */
      importText: function (text, name) {
        previewImport(String(text || ''), name || '');
        return true;
      },
      /* 直接喂一个 File 对象 */
      importFile: function (file) {
        if (!file) return false;
        if (!isTextFile(file)) return false;
        readFile(file, function (t, n) { previewImport(t, n); });
        return true;
      },
      applyImport: applyImport,
      getSource: getSource,
      exportList: exportList,
      reroll: reroll,
      todayWords: todayWords,
      getList: getList,
      setList: function (text) { ctx.storageSet('list', parseList(text)); ensureDay(); schedule(false); },
      getCount: getCount,
      setCount: setCount,
      getInterval: getInterval,
      setInterval: setIntervalMin,
      getState: function () {
        return {
          day: st.day, shown: st.shown, count: count(),
          finished: st.finished, days: st.days, total: st.total
        };
      },
      /* 道具：优先教新词，当天新词已教完则返回 null（由调用方提示） */
      teachNow: function () {
        if (!ensureDay()) return null;
        if (st.shown >= count()) return null;
        return showNext('item');
      },
      next: function () { return showNext('manual'); }
    };

    /* ---------------- 启动 ---------------- */
    loadState();
    if (ensureDay()) schedule(true);

    /* 把单词表拖到宠物身上：桌面透明穿透模式下窗口收不到拖放，
       所以这里只在浏览器模式/面板区域生效，主路径仍是面板按钮 */
    bindDrop(document.getElementById('pet'));
    const blockDocDrop = function (e) { e.preventDefault(); };
    document.addEventListener('dragover', blockDocDrop);
    document.addEventListener('drop', blockDocDrop);
    dropCleanups.push(function () {
      document.removeEventListener('dragover', blockDocDrop);
      document.removeEventListener('drop', blockDocDrop);
    });

    ctx.on('app:start', function () {
      if (ensureDay()) schedule(false);
    });

    /* 跨零点：第二天自动重置 */
    dayTimer = setInterval(function () {
      if (st.day !== todayKey()) { ensureDay(); schedule(false); renderPanel(); }
    }, 60000);

    ctx.onCleanup(function () {
      clearEatTimers();
      if (timer) clearTimeout(timer);
      if (dayTimer) clearInterval(dayTimer);
      dropCleanups.forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } });
      dropCleanups.length = 0;
      closePanel();
      if (panel && panel.remove) panel.remove();
      if (fileInput && fileInput.remove) fileInput.remove();
      panel = null; timer = null; dayTimer = null; fileInput = null;
      if (window.PetWord) delete window.PetWord;
      PET_WORD_API = null;
    });
  }
});
