/* ==========================================================
 * word-parser.js — 单词表文件解析器（纯函数，不碰 DOM，可在 Node 里直接测）
 *
 * 目标：用户手里的单词表千奇百怪，尽可能「读得懂」而不是要求用户先整理。
 * 支持的形态：
 *   · 竖线分隔    apple|/ˈæpl/|苹果|I eat an apple.
 *   · CSV 逗号     apple,/ˈæpl/,苹果,I eat an apple.
 *   · TSV 制表符   apple\t/ˈæpl/\t苹果
 *   · 中文逗号     apple，苹果
 *   · 冒号/等号    apple: 苹果  /  apple = 苹果
 *   · 空格分隔     apple 苹果
 *   · 纯单词列表   apple
 *   · JSON         ["apple"] / [{word,phonetic,meaning,example}] / {words:[...]}
 *   · 每行可带序号 1. apple 苹果 / - apple 苹果 / 1、apple 苹果
 *
 * 列含义是「打分猜」的，不是死按第 1/2/3/4 列：
 *   单词列  = 全是英文字母的那一列
 *   音标列  = 含 / 或 [ 且不含中文的那一列
 *   释义列  = 含中文的那一列
 *   例句列  = 剩下的那一列
 * 这样列顺序打乱（比如把中文写在音标前面）也能认出来。
 * ========================================================== */
(function () {
  'use strict';

  const MAX_WORDS = 5000;                                   // 再多就截断，避免超大文件卡死
  const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
  const WORD_RE = /^[A-Za-z][A-Za-z'\-]*(?:[ ][A-Za-z'\-]+)*$/;
  /* 序号后面常常没有空格（2、brave），所以序号分支用 \s*；
     而 - / * 这类符号必须跟着空格才认，避免把连字符开头的词吃掉 */
  const BULLET_RE = /^\s*(?:\d+[.、)．]\s*|[-*•·]\s+)/;
  const COMMENT_RE = /^(?:#|\/\/)/;

  const FIELD_ALIAS = {
    w: ['w', 'word', 'en', 'english', 'term', 'name', '单词', '英文'],
    p: ['p', 'phonetic', 'pron', 'pronunciation', 'ipa', 'uk', 'us', '音标', '发音'],
    c: ['c', 'cn', 'zh', 'meaning', 'translation', 'trans', 'def', 'definition', 'gloss',
        '中文', '释义', '意思', '翻译'],
    e: ['e', 'example', 'sentence', 'eg', '例句', '例子']
  };

  function isWord(s) { return WORD_RE.test(s) && s.length <= 40; }
  function isPhonetic(s) { return /[/[]/.test(s) && !CJK.test(s) && s.length <= 40; }
  function hasCJK(s) { return CJK.test(s); }

  /* 带引号保护的分割（CSV 里释义可能带逗号） */
  function splitLine(line, d) {
    if (d !== ',') return line.split(d);
    const out = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line.charAt(i);
      if (ch === '"') {
        if (inQ && line.charAt(i + 1) === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === ',' && !inQ) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }

  function stripBullet(line) { return line.replace(BULLET_RE, ''); }

  /* 嗅探分隔符：看哪个候选在多数行里都出现 */
  function sniffDelimiter(lines) {
    const sample = lines.slice(0, 60);
    /* 顺序有讲究：逗号要排在中文逗号前面，
       否则「apple,苹果，一种水果」这种混用的会被判成中文逗号分隔 */
    const cands = ['|', '\t', ',', ';', '；', '，', ':'];
    let best = null, bestRatio = 0;
    cands.forEach(function (d) {
      let hit = 0;
      sample.forEach(function (l) { if (l.indexOf(d) >= 0) hit++; });
      const ratio = sample.length ? hit / sample.length : 0;
      if (ratio > bestRatio) { bestRatio = ratio; best = d; }
    });
    /* 至少要在半数以上的行里出现才认，否则当纯文本处理 */
    return bestRatio >= 0.5 ? best : null;
  }

  function pickField(obj, aliases) {
    const keys = Object.keys(obj);
    for (let i = 0; i < aliases.length; i++) {
      const a = aliases[i].toLowerCase();
      for (let j = 0; j < keys.length; j++) {
        if (keys[j].toLowerCase() === a) return obj[keys[j]];
      }
    }
    return '';
  }

  function normalize(raw, idxHint) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'string') {
      const w = raw.trim();
      if (!isWord(w)) return null;
      return { w: w, p: '', c: '', e: '' };
    }
    if (typeof raw === 'object') {
      const w = String(pickField(raw, FIELD_ALIAS.w) || '').trim();
      if (!isWord(w)) return null;
      return {
        w: w,
        p: String(pickField(raw, FIELD_ALIAS.p) || '').trim(),
        c: String(pickField(raw, FIELD_ALIAS.c) || '').trim(),
        e: String(pickField(raw, FIELD_ALIAS.e) || '').trim()
      };
    }
    return null;
  }

  /* JSON：数组 / {words:[...]} / {list:[...]} / {data:[...]} */
  function parseJSON(text) {
    let data = null;
    try { data = JSON.parse(text); } catch (e) { return null; }
    let arr = null;
    if (Array.isArray(data)) arr = data;
    else if (data && typeof data === 'object') {
      const k = ['words', 'list', 'data', 'items', 'vocabulary'].filter(function (x) {
        return Array.isArray(data[x]);
      })[0];
      if (k) arr = data[k];
    }
    if (!arr) return null;
    return arr;
  }

  /* 按列打分猜每列是什么 */
  function mapColumns(rows) {
    const width = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    if (width <= 1) return { w: 0, p: -1, c: -1, e: -1 };

    function score(fn) {
      const s = [];
      for (let i = 0; i < width; i++) {
        let hit = 0, total = 0;
        rows.forEach(function (r) {
          const v = (r[i] || '').trim();
          if (!v) return;
          total++;
          if (fn(v)) hit++;
        });
        s.push(total ? hit / total : 0);
      }
      return s;
    }
    const sWord = score(isWord);
    const sPhon = score(isPhonetic);
    const sCJK = score(hasCJK);

    /* 单词列：单词分最高的那列（平手时取靠前的，通常就是第 1 列） */
    let w = 0, bestW = -1;
    for (let i = 0; i < width; i++) { if (sWord[i] > bestW + 0.001) { bestW = sWord[i]; w = i; } }

    function bestOf(scores, threshold, exclude) {
      let idx = -1, best = threshold;
      for (let i = 0; i < width; i++) {
        if (exclude.indexOf(i) >= 0) continue;
        if (scores[i] > best) { best = scores[i]; idx = i; }
      }
      return idx;
    }
    const p = bestOf(sPhon, 0.3, [w]);
    const used = [w].concat(p >= 0 ? [p] : []);
    const c = bestOf(sCJK, 0.3, used);
    const used2 = used.concat(c >= 0 ? [c] : []);
    /* 例句：剩下的第一列 */
    let e = -1;
    for (let i = 0; i < width; i++) { if (used2.indexOf(i) < 0) { e = i; break; } }
    /* 没有中文列但有第 2 列时，把它当作释义（英文释义也算） */
    const cc = (c >= 0) ? c : (width >= 2 && p !== (w === 0 ? 1 : 0) ? (w === 0 ? 1 : 0) : -1);
    return { w: w, p: p, c: cc, e: e };
  }

  /* 无分隔符的单行：apple 苹果 / apple: 苹果 / apple / 苹果（前面带音标） */
  function parseLoose(line) {
    let m = line.match(/^([A-Za-z][A-Za-z'\-]*)\s*[:：=＝]\s*(.+)$/);
    if (!m) m = line.match(/^([A-Za-z][A-Za-z'\-]*(?:[ ][A-Za-z'\-]+)*)\s{1,}(.+)$/);
    if (!m) {
      return isWord(line) ? { w: line, p: '', c: '', e: '' } : null;
    }
    let w = m[1].trim();
    let rest = m[2].trim();
    if (!isWord(w)) return null;
    let p = '', c = '';
    const pm = rest.match(/^(\/[^/]*\/|\[[^\]]*\])\s*(.*)$/);
    if (pm) { p = pm[1].trim(); c = pm[2].trim(); }
    else c = rest;
    return { w: w, p: p, c: c, e: '' };
  }

  /**
   * 解析单词表文本
   * @param {string} text   文件内容
   * @param {string} name   文件名（仅用于报错提示）
   * @returns {{ok:boolean, count:number, format:string, formatLabel:string,
   *            words:Array, sample:Array, skipped:number, dup:number,
   *            truncated:boolean, errors:string[], message:string}}
   */
  function parse(text, name) {
    const res = {
      ok: false, count: 0, format: 'unknown', formatLabel: '未知格式',
      words: [], sample: [], skipped: 0, dup: 0,
      truncated: false, errors: [], message: ''
    };
    if (text === null || text === undefined || String(text).trim() === '') {
      res.message = '文件是空的，换一个试试';
      return res;
    }

    let t = String(text).replace(/^\uFEFF/, '');
    const trimmed = t.trim();
    const fname = name || '';

    /* ---------- JSON ---------- */
    if (trimmed.charAt(0) === '[' || trimmed.charAt(0) === '{') {
      const arr = parseJSON(trimmed);
      if (arr) {
        arr.forEach(function (raw, i) {
          const w = normalize(raw, i);
          if (w) res.words.push(w); else res.skipped++;
        });
        res.format = 'json';
        res.formatLabel = 'JSON';
        return finish(res, fname);
      }
      res.errors.push('看起来是 JSON，但解析失败了，已按普通文本再试一次');
    }

    /* ---------- 逐行 ---------- */
    const lines = t.split(/\r?\n/);
    const useful = [];
    lines.forEach(function (raw, i) {
      let l = stripBullet(raw).trim();
      if (!l || COMMENT_RE.test(l)) return;
      useful.push({ line: l, no: i + 1 });
    });

    if (!useful.length) {
      res.message = '没读到任何内容，检查一下文件编码（建议 UTF-8）';
      return res;
    }

    const delim = sniffDelimiter(useful.map(function (x) { return x.line; }));
    let rows = [];
    let valid = [];

    if (delim) {
      rows = useful.map(function (x) { return splitLine(x.line, delim).map(function (s) { return s.trim(); }); });
      const map = mapColumns(rows);
      rows.forEach(function (r, i) {
        const w = (r[map.w] || '').trim();
        if (!isWord(w)) { res.skipped++; if (res.errors.length < 5) res.errors.push('第 ' + useful[i].no + ' 行看不懂，已跳过：' + useful[i].line.slice(0, 20)); return; }
        valid.push({
          w: w,
          p: map.p >= 0 ? (r[map.p] || '').trim() : '',
          c: map.c >= 0 ? (r[map.c] || '').trim() : '',
          e: map.e >= 0 ? (r[map.e] || '').trim() : ''
        });
      });
      res.format = delim === '|' ? 'pipe' : (delim === '\t' ? 'tsv' : (delim === ',' ? 'csv' : 'other'));
      res.formatLabel = { '|': '竖线分隔', '\t': '制表符 TSV', ',': 'CSV 逗号分隔', ';': '分号分隔', '；': '分号分隔', '，': '中文逗号分隔', ':': '冒号分隔' }[delim] || '分隔符「' + delim + '」';
    } else {
      useful.forEach(function (x) {
        const w = parseLoose(x.line);
        if (!w) { res.skipped++; if (res.errors.length < 5) res.errors.push('第 ' + x.no + ' 行看不懂，已跳过：' + x.line.slice(0, 20)); return; }
        valid.push(w);
      });
      res.format = 'loose';
      res.formatLabel = '空格/冒号分隔';
    }

    valid.forEach(function (w) { res.words.push(w); });
    return finish(res, fname);
  }

  /* 去重 + 截断 + 产出摘要 */
  function finish(res, fname) {
    const seen = {};
    const uniq = [];
    res.words.forEach(function (w) {
      const k = w.w.toLowerCase();
      if (seen[k]) { res.dup++; return; }
      seen[k] = 1;
      uniq.push(w);
    });
    res.words = uniq;

    if (res.words.length > MAX_WORDS) {
      res.words = res.words.slice(0, MAX_WORDS);
      res.truncated = true;
    }
    res.count = res.words.length;
    res.sample = res.words.slice(0, 3);
    res.ok = res.count > 0;
    if (!res.ok) {
      res.message = '一个单词都没认出来。每行请写成「单词 中文」或「单词|音标|中文|例句」';
    } else {
      res.message = fname
        ? '从「' + fname + '」读到 ' + res.count + ' 个单词'
        : '读到 ' + res.count + ' 个单词';
    }
    return res;
  }

  /* 导出为统一的竖线格式 */
  function toText(list) {
    return (list || []).map(function (x) {
      return [x.w, x.p || '', x.c || '', x.e || ''].join('|');
    }).join('\n');
  }

  window.WordParser = {
    parse: parse,
    toText: toText,
    MAX_WORDS: MAX_WORDS,
    /* 给外部（如平台扩展）直接塞结构化数据用 */
    normalizeList: function (arr) {
      const out = [];
      (arr || []).forEach(function (raw) { const w = normalize(raw); if (w) out.push(w); });
      return out;
    }
  };
})();
