/* ==========================================================
 * audio.js — 本地音频系统（自定义语音包）
 *
 * 用途：用户上传/录制的音频绑定到宠物事件分类，触发时优先
 * 播放（替代 TTS），气泡文字照常显示。全程本地处理，无网络。
 *
 * 规格：
 *   上传格式：WAV / MP3 / OGG / FLAC / M4A / WEBM（magic 探测）
 *   单文件 ≤ 2MB；音频时长 ≤ 20s（超长自动截断，重编码为 WAV）
 *   录制：MediaRecorder，默认 15s 上限自动停止，峰值归一化后
 *         转存 16bit PCM WAV
 *   存储：IndexedDB（desktoppet-audio / voicepack），启动时
 *         预取 objectURL 缓存（≤8 条），播放零延迟
 * ========================================================== */
(function () {
  'use strict';

  const DB_NAME = 'desktoppet-audio';
  const STORE = 'voicepack';
  const MAX_FILE_BYTES = 2 * 1024 * 1024;  // 2MB
  const MAX_SECONDS = 20;                  // 单条时长上限

  /* ---------------- 事件分类（与 speech.js PHRASES 对齐） ---------------- */
  const CATEGORIES = [
    { id: 'greetMorning', label: '问候', icon: '👋' },
    { id: 'onClick', label: '被点击', icon: '👆' },
    { id: 'onFeed', label: '被投喂', icon: '🍽️' },
    { id: 'onSleepy', label: '困倦', icon: '😴' },
    { id: 'chat', label: '闲聊', icon: '💬' },
    { id: 'remindDrink', label: '提醒', icon: '⏰' }
  ];

  /* ---------------- IndexedDB 封装 ---------------- */
  function dbOpen() {
    return new Promise(function (resolve, reject) {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        try { req.result.createObjectStore(STORE); } catch (e) { /* ignore */ }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB 打开失败')); };
    });
  }
  function tx(db, mode) { return db.transaction(STORE, mode).objectStore(STORE); }
  function dbPut(key, rec) {
    return dbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        const r = tx(db, 'readwrite').put(rec, key);
        r.onsuccess = function () { resolve(true); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }
  function dbGet(key) {
    return dbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        const r = tx(db, 'readonly').get(key);
        r.onsuccess = function () { resolve(r.result || null); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }
  function dbDelete(key) {
    return dbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        const r = tx(db, 'readwrite').delete(key);
        r.onsuccess = function () { resolve(true); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }
  function dbKeys() {
    return dbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        const r = tx(db, 'readonly').getAllKeys();
        r.onsuccess = function () { resolve(r.result || []); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }

  /* ---------------- 格式探测（magic number） ---------------- */
  async function detectFormat(blob) {
    try {
      const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
      const ascii = function (i, j) {
        let s = '';
        for (let k = i; k < j; k++) s += String.fromCharCode(head[k]);
        return s;
      };
      if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav';
      if (ascii(0, 4) === 'OggS') return 'ogg';
      if (ascii(0, 4) === 'fLaC') return 'flac';
      if (ascii(4, 8) === 'ftyp') return 'm4a';
      if (ascii(0, 3) === 'ID3') return 'mp3';
      if (head[0] === 0xFF && (head[1] & 0xE0) === 0xE0) return 'mp3';
      if (head[0] === 0x1A && head[1] === 0x45 && head[2] === 0xDF && head[3] === 0xA3) return 'webm';
      return null;
    } catch (e) { return null; }
  }

  /* ---------------- WAV 编码（16bit PCM） ---------------- */
  function encodeWav(buffer) {
    const numCh = buffer.numberOfChannels;
    const len = buffer.length;
    const rate = buffer.sampleRate;
    const blockAlign = numCh * 2;
    const dataSize = len * blockAlign;
    const ab = new ArrayBuffer(44 + dataSize);
    const v = new DataView(ab);
    let off = 0;
    function wstr(s) { for (let i = 0; i < s.length; i++) v.setUint8(off++, s.charCodeAt(i)); }
    function u32(x) { v.setUint32(off, x, true); off += 4; }
    function u16(x) { v.setUint16(off, x, true); off += 2; }
    wstr('RIFF'); u32(36 + dataSize); wstr('WAVE');
    wstr('fmt '); u32(16); u16(1); u16(numCh); u32(rate); u32(rate * blockAlign); u16(blockAlign); u16(16);
    wstr('data'); u32(dataSize);
    const chans = [];
    for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < numCh; c++) {
        let s = Math.max(-1, Math.min(1, chans[c][i]));
        v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        off += 2;
      }
    }
    return new Blob([ab], { type: 'audio/wav' });
  }

  /* ---------------- 峰值归一化 + 截断（输出 WAV Blob） ---------------- */
  async function normalizeToWav(audioBuffer, maxSec) {
    const limitSec = Math.min(audioBuffer.duration, maxSec || MAX_SECONDS);
    const rate = audioBuffer.sampleRate;
    const outLen = Math.floor(limitSec * rate);
    const off = new OfflineAudioContext(audioBuffer.numberOfChannels, outLen, rate);
    const src = off.createBufferSource();
    src.buffer = audioBuffer;
    const gain = off.createGain();
    src.connect(gain).connect(off.destination);
    src.start(0);

    /* 先测原峰值（前 limitSec 内）以决定增益，目标 -3dB */
    let peak = 0;
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      const data = audioBuffer.getChannelData(c);
      const n = Math.min(data.length, outLen);
      for (let i = 0; i < n; i += 7) { /* 抽样扫描足够精确 */
        const a = Math.abs(data[i]);
        if (a > peak) peak = a;
      }
    }
    gain.gain.value = (peak > 0.02 && peak < 0.98) ? Math.min(3, 0.7 / peak) : 1;

    const rendered = await off.startRendering();
    return { blob: encodeWav(rendered), duration: rendered.duration };
  }

  /* ---------------- 槽位缓存（objectURL） ---------------- */
  const slots = new Map();   // key -> { url, label, duration }
  let storageOk = true;
  let enabled = true;
  let currentAudio = null;

  async function init() {
    try {
      const keys = await dbKeys();
      for (const k of keys) {
        const rec = await dbGet(k);
        if (rec && rec.blob instanceof Blob) {
          slots.set(k, {
            url: URL.createObjectURL(rec.blob),
            label: rec.label || '',
            duration: rec.duration || 0
          });
        }
      }
    } catch (e) {
      storageOk = false;
      console.warn('[AudioSystem] IndexedDB 不可用，语音包降级为会话内存模式', e);
    }
  }

  /* ---------------- 保存槽位 ---------------- */
  async function saveSlot(key, blob, label, opts) {
    opts = opts || {};
    if (!(blob instanceof Blob) || blob.size === 0) throw new Error('音频内容为空');
    if (blob.size > MAX_FILE_BYTES) throw new Error('音频超过 2MB 大小限制');

    const fmt = await detectFormat(blob);
    if (!fmt) throw new Error('不支持的音频格式（支持 WAV/MP3/OGG/FLAC/M4A/WEBM）');

    /* 解码校验（同时获得时长） */
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    let audioBuf;
    const ctx = new AudioCtx();
    try {
      const ab = await blob.arrayBuffer();
      audioBuf = await ctx.decodeAudioData(ab);
    } catch (e) {
      ctx.close();
      throw new Error('音频无法解码，请换一个文件');
    }
    ctx.close();
    if (audioBuf.duration < 0.3) throw new Error('音频太短（至少 0.3 秒）');

    /* 需要归一化（录制）或超长截断（上传 >20s）时，统一重编码 WAV */
    let finalBlob = blob;
    let duration = audioBuf.duration;
    if (opts.normalize || duration > MAX_SECONDS) {
      const r = await normalizeToWav(audioBuf, MAX_SECONDS);
      finalBlob = r.blob;
      duration = r.duration;
      if (finalBlob.size > MAX_FILE_BYTES) throw new Error('处理后的音频超过 2MB 限制');
    }

    const rec = {
      blob: finalBlob,
      label: (label || '').slice(0, 40),
      mime: finalBlob.type,
      duration: Math.round(duration * 10) / 10,
      createdAt: Date.now()
    };
    if (storageOk) {
      try { await dbPut(key, rec); } catch (e) { storageOk = false; }
    }
    if (slots.has(key)) { try { URL.revokeObjectURL(slots.get(key).url); } catch (e) { /* ignore */ } }
    slots.set(key, { url: URL.createObjectURL(rec.blob), label: rec.label, duration: rec.duration });
    return rec;
  }

  async function removeSlot(key) {
    if (slots.has(key)) {
      try { URL.revokeObjectURL(slots.get(key).url); } catch (e) { /* ignore */ }
      slots.delete(key);
    }
    if (storageOk) { try { await dbDelete(key); } catch (e) { /* ignore */ } }
  }

  async function setLabel(key, label) {
    const slot = slots.get(key);
    if (!slot) return;
    slot.label = (label || '').slice(0, 40);
    if (storageOk) {
      try {
        const rec = await dbGet(key);
        if (rec) { rec.label = slot.label; await dbPut(key, rec); }
      } catch (e) { /* ignore */ }
    }
  }

  /* ---------------- 录制（MediaRecorder 控制器） ---------------- */
  function startRecording(opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
        reject(new Error('当前浏览器不支持录音'));
        return;
      }
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        let mr;
        try { mr = new MediaRecorder(stream); }
        catch (e) {
          stream.getTracks().forEach(function (t) { t.stop(); });
          reject(new Error('录音组件初始化失败'));
          return;
        }
        const chunks = [];
        mr.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };

        let done = false;
        let autoTimer = null;
        const controller = {
          stop: function () {
            return new Promise(function (resolve2) {
              if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
              mr.onstop = function () {
                try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
                resolve2(new Blob(chunks, { type: mr.mimeType || 'audio/webm' }));
              };
              if (mr.state !== 'inactive') mr.stop();
              else mr.onstop();
            });
          }
        };
        autoTimer = setTimeout(function () { controller.stop(); }, opts.maxMs || 15000);
        mr.start(250);
        resolve(controller);
      }).catch(function (e) {
        reject(new Error('无法访问麦克风，请检查浏览器权限'));
      });
    });
  }

  /* ---------------- 播放（互斥） ---------------- */
  function play(key) {
    const slot = slots.get(key);
    if (!slot) return false;
    stop();
    try {
      currentAudio = new Audio(slot.url);
      currentAudio.onended = function () { currentAudio = null; };
      currentAudio.play().catch(function () { currentAudio = null; });
      return true;
    } catch (e) { currentAudio = null; return false; }
  }
  function stop() {
    if (currentAudio) {
      try { currentAudio.pause(); } catch (e) { /* ignore */ }
      currentAudio = null;
    }
  }

  /* ---------------- 导出 ---------------- */
  window.AudioSystem = {
    CATEGORIES: CATEGORIES,
    init: init,
    has: function (key) { return enabled && slots.has(key); },
    getSlot: function (key) {
      const s = slots.get(key);
      return s ? { label: s.label, duration: s.duration } : null;
    },
    saveSlot: saveSlot,
    removeSlot: removeSlot,
    setLabel: setLabel,
    startRecording: startRecording,
    play: play,
    stop: stop,
    detectFormat: detectFormat,
    setEnabled: function (v) { enabled = !!v; if (!v) stop(); },
    getEnabled: function () { return enabled; },
    MAX_FILE_BYTES: MAX_FILE_BYTES,
    MAX_SECONDS: MAX_SECONDS
  };
})();
