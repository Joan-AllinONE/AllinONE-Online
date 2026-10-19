/* ==========================================================
 * main.js — 主程序装配
 * 职责：初始化核心与渲染器（SVG / Rig / Image 自动选择与降级）、
 *       技能动作工具栏、状态面板、设置面板、语音包管理、
 *       图片上传、粒子特效、存档管理、桌面驻留模式协作。
 * ========================================================== */
(function () {
  'use strict';

  function $(s) { return document.querySelector(s); }

  /* ================= 存档 ================= */
  const SAVE_KEY = 'desktoppet.v1';

  function loadSave() {
    try { return JSON.parse(localStorage.getItem(SAVE_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function persist(data) {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch (e) { /* ignore */ }
  }

  const save = loadSave();
  save.settings = save.settings || {};
  save.stats = save.stats || {};

  let appearance = save.appearance === 'custom' && save.customImage ? 'custom' : 'cat';

  function saveAll() {
    persist({
      stats: window.PetCore.getStats(),
      pos: window.PetCore.getRelativePos(),
      settings: {
        tts: window.SpeechSystem.getTtsEnabled(),
        rate: window.SpeechSystem.getRate()
      },
      skills: window.PetSkills.getEnabledMap(),
      appearance: appearance,
      customImage: save.customImage || null
    });
  }

  /* ================= 运行环境检测 =================
   * 两种宿主：
   *   1. 桌面宠物模式（electron/ 目录）：preload 注入 window.petHost，
   *      真透明 + 置顶 + 鼠标穿透，实现见 electron/main.js
   *   2. 普通浏览器窗口（默认，双击 index.html）
   */
  const isDesktopMode = !!window.petHost;

  if (isDesktopMode) {
    document.body.classList.add('transparent');
  } else if (location.search.indexOf('transparent') >= 0) {
    document.body.classList.add('transparent');
  }

  /* ================= 初始化核心 ================= */
  const petEl = $('#pet');
  const spriteEl = $('#pet-sprite');

  window.PetCore.init({
    petEl: petEl,
    spriteEl: spriteEl,
    pos: save.pos || null
  });
  if (save.stats) window.PetCore.setStatsAll(save.stats);

  /* ================= 粒子特效 ================= */
  const FX_ICONS = { heart: '💗', star: '⭐', crumb: '🍚', sparkle: '✨' };

  window.PetFX = {
    spawn: function (type, count) {
      const petRect = petEl.getBoundingClientRect();
      const cx = petRect.left + petRect.width / 2;
      const cy = petRect.top + petRect.height * 0.25;
      const n = count || 4;
      for (let i = 0; i < n; i++) {
        const el = document.createElement('div');
        el.className = 'fx';
        el.textContent = FX_ICONS[type] || '✨';
        el.style.left = (cx + (Math.random() * 70 - 35)) + 'px';
        el.style.top = (cy + Math.random() * 20) + 'px';
        el.style.setProperty('--fx-dx', (Math.random() * 60 - 30) + 'px');
        el.style.fontSize = (16 + Math.random() * 10) + 'px';
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 1600);
      }
    },
    spawnZzz: function () {
      const petRect = petEl.getBoundingClientRect();
      const el = document.createElement('div');
      el.className = 'fx fx-zzz';
      el.textContent = 'Z';
      el.style.left = (petRect.left + petRect.width * 0.72) + 'px';
      el.style.top = (petRect.top + petRect.height * 0.12) + 'px';
      el.style.fontSize = (14 + Math.random() * 8) + 'px';
      document.body.appendChild(el);
      setTimeout(function () { el.remove(); }, 2500);
    }
  };

  window.PetCore.on('pet:click', function () { window.PetFX.spawn('heart', 3); });
  window.PetCore.on('pet:feed:end', function () { window.PetFX.spawn('sparkle', 4); });
  window.PetCore.on('pet:dragstart', function () { window.PetFX.spawn('sparkle', 2); });

  setInterval(function () {
    const st = window.PetCore.getAnimState();
    if (st === 'sleepy' || st === 'sleeping') window.PetFX.spawnZzz();
  }, 1900);

  /* ================= Toast 通知 ================= */
  let toastTimer = null;
  window.PetUI = {
    toast: function (msg) {
      const el = $('#toast');
      if (!el) return;
      el.textContent = msg;
      el.classList.remove('hidden');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 2600);
    }
  };

  /* ================= 渲染器（形象）管理 =================
   * custom 形象优先使用 RigRenderer（自动抠图 + 表情 + 全套动画），
   * 处理异常时回退 ImageRenderer（圆角卡片模式），保持零中断。
   */
  let currentRenderer = null;

  function applyAppearance(anim) {
    if (currentRenderer && currentRenderer.destroy) {
      try { currentRenderer.destroy(); } catch (e) { /* ignore */ }
    }
    if (appearance === 'custom' && save.customImage) {
      try {
        currentRenderer = window.PetRenderers.rig(save.customImage);
      } catch (e) {
        currentRenderer = window.PetRenderers.image(save.customImage);
      }
    } else {
      currentRenderer = window.PetRenderers.svg();
    }
    window.PetCore.setRenderer(currentRenderer);
    if (anim) window.PetCore.setAnimState('happy', 1800);
  }
  applyAppearance(false);

  /* ================= 技能动作工具栏 ================= */
  function renderSkillActions() {
    const wrap = $('#skill-actions');
    if (!wrap) return;
    wrap.innerHTML = '';
    window.PetSkills.getActionButtons().forEach(function (btn) {
      const b = document.createElement('button');
      b.className = 'tool-btn';
      b.title = btn.title;
      b.setAttribute('aria-label', btn.title);
      b.textContent = btn.icon;
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        btn.onClick();
      });
      wrap.appendChild(b);
    });
  }
  window.PetCore.on('skills:change', renderSkillActions);
  renderSkillActions();

  /* ================= 状态面板 ================= */
  function refreshStats() {
    const stats = window.PetCore.getStats();
    document.querySelectorAll('#stats-panel .stat-row').forEach(function (row) {
      const key = row.getAttribute('data-stat');
      const v = Math.round(stats[key] || 0);
      const fill = row.querySelector('.stat-fill');
      const num = row.querySelector('.stat-num');
      if (fill) {
        fill.style.width = v + '%';
        fill.classList.toggle('danger', v < 30);
      }
      if (num) num.textContent = v;
    });
  }
  window.PetCore.on('stats:change', refreshStats);
  refreshStats();

  const statsPanel = $('#stats-panel');
  $('#stats-toggle').addEventListener('click', function () {
    statsPanel.classList.toggle('collapsed');
  });

  /* ================= 设置面板 ================= */
  const settingsPanel = $('#settings-panel');

  function openSettings() { settingsPanel.classList.remove('hidden'); }
  function closeSettings() { settingsPanel.classList.add('hidden'); }

  $('#btn-settings').addEventListener('click', function (e) {
    e.stopPropagation();
    if (settingsPanel.classList.contains('hidden')) openSettings();
    else closeSettings();
  });
  $('#settings-close').addEventListener('click', closeSettings);

  // 运行模式提示（桌面驻留 / 窗口）
  (function renderHostBadge() {
    const head = settingsPanel.querySelector('.settings-head h2');
    if (!head || !isDesktopMode) return;
    const tag = document.createElement('span');
    tag.className = 'host-badge';
    tag.textContent = '🖥 桌面宠物模式';
    head.appendChild(tag);
  })();

  // 初始读取语音设置
  if (typeof save.settings.tts === 'boolean') window.SpeechSystem.setTtsEnabled(save.settings.tts);
  if (typeof save.settings.rate === 'number') window.SpeechSystem.setRate(save.settings.rate);

  const optTts = $('#opt-tts');
  const optRate = $('#opt-rate');
  const rateValue = $('#rate-value');

  optTts.checked = window.SpeechSystem.getTtsEnabled();
  optRate.value = window.SpeechSystem.getRate();
  rateValue.textContent = Number(window.SpeechSystem.getRate()).toFixed(1) + 'x';

  optTts.addEventListener('change', function () {
    window.SpeechSystem.setTtsEnabled(optTts.checked);
    saveAll();
    if (optTts.checked) window.SpeechSystem.sayText('语音已开启，我能说话啦！');
    else window.PetUI.toast('语音朗读已关闭（气泡仍会显示）');
  });

  optRate.addEventListener('input', function () {
    window.SpeechSystem.setRate(optRate.value);
    rateValue.textContent = Number(optRate.value).toFixed(1) + 'x';
  });
  optRate.addEventListener('change', function () {
    saveAll();
    window.SpeechSystem.sayText('现在的语速是这样，还合适吗？');
  });

  /* ================= 桌面宠物模式入口 =================
   * 浏览器窗口受安全限制，做不到「透明 / 始终置顶 / 点击穿透桌面」，
   * 这三件事只能由桌面组件（Electron）完成。所以网页上的入口做的是
   * 「唤起桌面组件」，而不是在浏览器里假装透明。
   *
   * 唤起方式：自定义协议 desktoppet://（注册表写在 HKCU，无需管理员，
   * 注册脚本见项目根目录 register-protocol.vbs）。
   */
  const btnDesktop = $('#btn-desktop');
  const btnDesktopLaunch = $('#btn-desktop-launch');
  const btnFullscreen = $('#btn-fullscreen');
  const desktopGuide = $('#desktop-guide');
  const desktopGuideText = $('#desktop-guide-text');

  function showDesktopGuide(html) {
    if (desktopGuideText && html) desktopGuideText.innerHTML = html;
    openSettings();
    if (!desktopGuide) return;
    desktopGuide.classList.remove('flash');
    void desktopGuide.offsetWidth;          // 强制重排，保证高亮动画可重复触发
    desktopGuide.classList.add('flash');
    if (desktopGuide.scrollIntoView) {
      desktopGuide.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function launchDesktopMode() {
    /* 用隐藏 iframe 触发协议：即便协议未注册，当前页面也不会被导航走 */
    let frame = document.getElementById('pet-protocol-frame');
    if (!frame) {
      frame = document.createElement('iframe');
      frame.id = 'pet-protocol-frame';
      frame.style.display = 'none';
      document.body.appendChild(frame);
    }

    window.PetUI.toast('正在进入桌面宠物模式…');

    /* 协议生效时桌面组件会抢走焦点 → 用 blur 判定是否真的起来了。
       等待时间留足，因为浏览器可能先弹「是否允许打开外部应用」。 */
    let launched = false;
    function onBlur() { launched = true; }
    window.addEventListener('blur', onBlur, { once: true });

    frame.src = 'desktoppet://start';

    setTimeout(function () {
      window.removeEventListener('blur', onBlur);
      if (launched) return;
      showDesktopGuide(
        '没有唤起桌面组件，通常是启动协议还没注册（只需做一次）：<br>' +
        '双击项目根目录的 <code>register-protocol.vbs</code>，' +
        '回到本页面再点一次按钮即可。<br>' +
        '也可以直接双击 <code>启动桌面宠物.bat</code> 进入桌面模式。'
      );
    }, 4000);
  }

  if (isDesktopMode) {
    /* 已在桌面模式：入口按钮没有意义，直接移除并给出状态说明 */
    if (btnDesktop) btnDesktop.remove();
    if (btnDesktopLaunch) btnDesktopLaunch.remove();
    if (desktopGuideText) {
      desktopGuideText.innerHTML =
        '✅ 当前已经处于桌面宠物模式：透明背景、始终置顶、点击穿透桌面。<br>' +
        '退出方式：<b>右键宠物</b> → 退出桌面宠物，或用下面这个按钮，' +
        '也可以右键系统托盘图标退出。';
    }
  } else {
    if (btnDesktop) {
      btnDesktop.addEventListener('click', function (e) {
        e.stopPropagation();
        launchDesktopMode();
      });
    }
    if (btnDesktopLaunch) {
      btnDesktopLaunch.addEventListener('click', function (e) {
        e.stopPropagation();
        launchDesktopMode();
      });
    }
  }

  /* 全屏只是备用的「大视野」方案：不透明、也不能真正置顶 */
  if (btnFullscreen) {
    btnFullscreen.addEventListener('click', function (e) {
      e.stopPropagation();
      try {
        if (!document.fullscreenElement) document.documentElement.requestFullscreen();
        else document.exitFullscreen();
      } catch (err) {
        window.PetUI.toast('当前浏览器不支持全屏切换');
      }
    });
  }

  /* ================= 退出方式 / 宠物右键菜单 =================
   * 桌面模式是透明无边框窗口，没有关闭按钮，原先只能靠托盘退出，
   * 藏得太深。这里补两条更直白的出路：
   *   1) 右键宠物 → 菜单（打开设置 / 隐藏显示 / 退出）
   *   2) 设置 →「🖥 桌面宠物模式」→ 退出桌面宠物
   */
  const ctxMenu = $('#ctx-menu');
  const btnQuitDesktop = $('#btn-quit-desktop');

  function quitDesktopPet() {
    if (!(window.petHost && window.petHost.quitApp)) {
      window.PetUI.toast('当前是浏览器模式，直接关闭这个标签页就行啦');
      return;
    }
    saveAll();                     // 退出前先落盘，避免丢进度
    window.PetUI.toast('再见啦，下次再一起玩～');
    setTimeout(function () { window.petHost.quitApp(); }, 700);
  }

  function hideCtxMenu() {
    if (ctxMenu) ctxMenu.classList.add('hidden');
  }

  function showCtxMenu(x, y) {
    if (!ctxMenu) return;
    ctxMenu.classList.remove('hidden');
    const r = ctxMenu.getBoundingClientRect();   // 先显示再量，否则量不到尺寸
    let left = x, top = y;
    if (left + r.width > window.innerWidth - 8) left = window.innerWidth - r.width - 8;
    if (top + r.height > window.innerHeight - 8) top = window.innerHeight - r.height - 8;
    ctxMenu.style.left = Math.max(8, left) + 'px';
    ctxMenu.style.top = Math.max(8, top) + 'px';
  }

  if (isDesktopMode) {
    /* core.js 的拖拽只认 e.button === 0，右键不会被误判成拖拽 */
    petEl.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      showCtxMenu(e.clientX, e.clientY);
    });

    document.addEventListener('click', function (e) {
      if (ctxMenu && !ctxMenu.contains(e.target)) hideCtxMenu();
    });
    document.addEventListener('contextmenu', function (e) {
      if (ctxMenu && !ctxMenu.contains(e.target)) hideCtxMenu();
    });
    window.addEventListener('blur', hideCtxMenu);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') hideCtxMenu();
    });

    if (ctxMenu) {
      ctxMenu.addEventListener('click', function (e) {
        const item = e.target.closest ? e.target.closest('.ctx-item') : null;
        if (!item) return;
        e.stopPropagation();
        hideCtxMenu();
        const act = item.getAttribute('data-act');
        if (act === 'settings') openSettings();
        else if (act === 'hide' && window.petHost.toggleVisible) window.petHost.toggleVisible();
        else if (act === 'quit') quitDesktopPet();
      });
    }

    if (btnQuitDesktop) {
      btnQuitDesktop.hidden = false;
      btnQuitDesktop.addEventListener('click', function (e) {
        e.stopPropagation();
        quitDesktopPet();
      });
    }
  } else {
    /* 浏览器模式没有「退出程序」这回事，去掉这些入口免得误解 */
    if (ctxMenu) ctxMenu.remove();
    if (btnQuitDesktop) btnQuitDesktop.remove();
  }

  /* ---------- 形象选择与图片上传 ---------- */
  function selectAppearanceOption(kind) {
    document.querySelectorAll('.appearance-option').forEach(function (opt) {
      opt.classList.toggle('selected', opt.getAttribute('data-pet') === kind);
    });
  }
  function setCustomPreview(src) {
    const el = $('#custom-preview');
    if (!el) return;
    if (src) {
      el.innerHTML = '';
      const img = document.createElement('img');
      img.src = src;
      el.appendChild(img);
    } else {
      el.textContent = '🖼️';
    }
  }
  if (save.customImage) setCustomPreview(save.customImage);
  selectAppearanceOption(appearance);

  /* 对外接口：供 AllinONE 扩展皮肤（skins slot）切换形象调用 */
  window.PetAppearance = {
    setCustomImage: function (dataUrl, opts) {
      if (!dataUrl) return false;
      const persist = !(opts && opts.persist === false);   // AllinONE 内容凭证皮肤传 false：按次生效，不写存档
      save.customImage = dataUrl;
      appearance = 'custom';
      selectAppearanceOption('custom');
      setCustomPreview(dataUrl);
      applyAppearance(true);
      if (persist) saveAll();
      return true;
    },
    reset: function () {
      appearance = 'cat';
      save.customImage = null;
      selectAppearanceOption('cat');
      setCustomPreview(null);
      applyAppearance(true);
      saveAll();
    }
  };

  const uploadInput = $('#upload-input');

  $('#btn-pet-cat').addEventListener('click', function () {
    appearance = 'cat';
    selectAppearanceOption('cat');
    applyAppearance(true);
    saveAll();
    window.PetUI.toast('已切换为橘小猫');
  });

  $('#btn-pet-custom').addEventListener('click', function () {
    if (appearance === 'custom' && save.customImage) {
      applyAppearance(true);
      saveAll();
      window.PetUI.toast('已切换为自定义形象');
      return;
    }
    uploadInput.click();
  });

  uploadInput.addEventListener('change', function (e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    window.PetRenderers.prepareImageFile(file, 260, function (dataURL) {
      if (!dataURL) {
        window.PetUI.toast('图片读取失败，换一张试试吧');
        return;
      }
      save.customImage = dataURL;
      appearance = 'custom';
      selectAppearanceOption('custom');
      setCustomPreview(dataURL);
      applyAppearance(true);
      saveAll();
      const mode = currentRenderer && currentRenderer.getMode ? currentRenderer.getMode() : '';
      window.PetUI.toast(mode === 'face' ? '🎉 专属可动桌宠已生成！' : '🎉 桌宠已生成（已启用全套动画）');
      window.PetFX.spawn('star', 6);
      window.SpeechSystem.sayText('哇，这是新的我吗？好可爱！');
    });
    uploadInput.value = '';
  });

  /* ================= 自定义语音包管理 UI ================= */
  let activeRecorder = null;    // { stop(): Promise<Blob> }
  let recordingCategory = null;

  function vpRefreshRow(row, cat) {
    const slot = window.AudioSystem.getSlot(cat.id);
    const status = row.querySelector('[data-status]');
    if (slot) {
      status.textContent = '自定义 · ' + (slot.duration || 0) + 's' + (slot.label ? ' · ' + slot.label : '');
      status.classList.add('custom');
      row.querySelector('[data-act="play"]').disabled = false;
      row.querySelector('[data-act="remove"]').disabled = false;
      row.querySelector('[data-label]').value = slot.label || '';
    } else {
      status.textContent = '默认 TTS';
      status.classList.remove('custom');
      row.querySelector('[data-act="play"]').disabled = true;
      row.querySelector('[data-act="remove"]').disabled = true;
      row.querySelector('[data-label]').value = '';
    }
  }

  async function vpSaveAudio(cat, blob, row, isRecording) {
    try {
      const labelInput = row.querySelector('[data-label]');
      const rec = await window.AudioSystem.saveSlot(cat.id, blob, labelInput.value, { normalize: !!isRecording });
      vpRefreshRow(row, cat);
      window.PetUI.toast('🎤「' + cat.label + '」语音已保存（' + rec.duration + 's）');
    } catch (err) {
      window.PetUI.toast('保存失败：' + (err && err.message ? err.message : '未知错误'));
    }
  }

  async function vpToggleRecord(cat, row, recordBtn) {
    /* 已在录制 → 停止并保存 */
    if (activeRecorder && recordingCategory === cat.id) {
      const blob = await activeRecorder.stop();
      activeRecorder = null;
      recordingCategory = null;
      row.classList.remove('recording');
      recordBtn.textContent = '🎤';
      recordBtn.title = '录制';
      if (blob && blob.size) vpSaveAudio(cat, blob, row, true);
      return;
    }
    if (activeRecorder) {
      window.PetUI.toast('请先停止当前正在进行的录制');
      return;
    }
    try {
      activeRecorder = await window.AudioSystem.startRecording({ maxMs: 15000 });
      recordingCategory = cat.id;
      row.classList.add('recording');
      recordBtn.textContent = '⏹';
      recordBtn.title = '停止（最长 15 秒）';
      window.PetUI.toast('🎙 开始录制「' + cat.label + '」…最多 15 秒');
      /* 录制满 15s 自动停止 */
      (function pollStop() {
        if (!activeRecorder || recordingCategory !== cat.id) return;
        setTimeout(function () {
          if (activeRecorder && recordingCategory === cat.id) {
            vpToggleRecord(cat, row, recordBtn);
          }
        }, 15200);
      })();
    } catch (err) {
      window.PetUI.toast(err && err.message ? err.message : '录音启动失败');
    }
  }

  function renderVoicepack() {
    const wrap = $('#voicepack-list');
    if (!wrap) return;
    wrap.innerHTML = '';
    window.AudioSystem.CATEGORIES.forEach(function (cat) {
      const row = document.createElement('div');
      row.className = 'vp-row';
      row.innerHTML =
        '<span class="vp-icon">' + cat.icon + '</span>' +
        '<div class="vp-info">' +
          '<div class="vp-name">' + cat.label + '</div>' +
          '<div class="vp-status" data-status>默认 TTS</div>' +
          '<input class="vp-label-input" data-label placeholder="台词文字（可选，气泡显示）" maxlength="40"/>' +
        '</div>' +
        '<div class="vp-actions">' +
          '<button class="vp-btn" data-act="record" title="麦克风录制">🎤</button>' +
          '<button class="vp-btn" data-act="upload" title="上传音频文件">📁</button>' +
          '<button class="vp-btn" data-act="play" title="试听" disabled>▶️</button>' +
          '<button class="vp-btn" data-act="remove" title="移除（恢复默认 TTS）" disabled>✕</button>' +
        '</div>';

      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'audio/*,.wav,.mp3,.ogg,.flac,.m4a,.webm';
      fileInput.hidden = true;
      row.appendChild(fileInput);

      const recordBtn = row.querySelector('[data-act="record"]');

      recordBtn.addEventListener('click', function () { vpToggleRecord(cat, row, recordBtn); });

      row.querySelector('[data-act="upload"]').addEventListener('click', function () {
        if (activeRecorder) { window.PetUI.toast('请先停止正在进行的录制'); return; }
        fileInput.click();
      });
      fileInput.addEventListener('change', function (e) {
        const file = e.target.files && e.target.files[0];
        if (file) vpSaveAudio(cat, file, row, false);
        fileInput.value = '';
      });

      row.querySelector('[data-act="play"]').addEventListener('click', function () {
        window.AudioSystem.play(cat.id);
      });

      row.querySelector('[data-act="remove"]').addEventListener('click', async function () {
        await window.AudioSystem.removeSlot(cat.id);
        vpRefreshRow(row, cat);
        window.PetUI.toast('「' + cat.label + '」已恢复默认 TTS');
      });

      row.querySelector('[data-label]').addEventListener('change', function (e) {
        window.AudioSystem.setLabel(cat.id, e.target.value);
        vpRefreshRow(row, cat);
      });

      vpRefreshRow(row, cat);
      wrap.appendChild(row);
    });
  }
  renderVoicepack();

  // 音频系统初始化（预取已存语音 → 刷新槽位状态）
  window.AudioSystem.init().then(function () {
    renderVoicepack();
  }).catch(function () { /* 降级为内存模式已在内部处理 */ });

  /* ---------- 技能开关列表 ---------- */
  function renderSkillList() {
    const listEl = $('#skill-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    const skills = window.PetSkills.list();
    if (!skills.length) {
      listEl.innerHTML = '<p class="settings-tip">尚未注册任何技能。</p>';
      return;
    }
    skills.forEach(function (s) {
      const row = document.createElement('div');
      row.className = 'skill-row';

      const icon = document.createElement('span');
      icon.className = 'skill-icon';
      icon.textContent = s.icon;

      const info = document.createElement('div');
      info.className = 'skill-info';
      const name = document.createElement('div');
      name.className = 'skill-name';
      name.textContent = s.name;
      const desc = document.createElement('div');
      desc.className = 'skill-desc';
      desc.textContent = s.description;
      info.appendChild(name);
      info.appendChild(desc);

      const sw = document.createElement('label');
      sw.className = 'switch';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = s.enabled;
      cb.addEventListener('change', function () {
        window.PetSkills.toggle(s.id, cb.checked);
        renderSkillActions();
        window.PetUI.toast('技能「' + s.name + '」已' + (cb.checked ? '开启' : '关闭'));
        saveAll();
      });
      const knob = document.createElement('i');
      sw.appendChild(cb);
      sw.appendChild(knob);

      row.appendChild(icon);
      row.appendChild(info);
      row.appendChild(sw);
      listEl.appendChild(row);
    });
  }
  renderSkillList();
  window.PetCore.on('skills:change', renderSkillList);

  /* ---------- 重置数据 ---------- */
  $('#btn-reset').addEventListener('click', function () {
    try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
    window.PetUI.toast('数据已重置，即将刷新…');
    setTimeout(function () { location.reload(); }, 900);
  });

  /* ================= 存档循环 ================= */
  setInterval(saveAll, 10000);
  window.addEventListener('beforeunload', saveAll);

  /* ================= 启动 ================= */
  setTimeout(function () {
    window.PetCore.emit('app:start');
    window.PetFX.spawn('sparkle', 3);
  }, 500);
})();
