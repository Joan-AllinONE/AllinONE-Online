/* ==========================================================
 * speech.js — 本地语音系统
 * 全部文案为本地预置内容（约束：不接入 AI）。
 * 展示层：桌面气泡；朗读层：浏览器 speechSynthesis 本地合成（可关闭）。
 * ========================================================== */
(function () {
  'use strict';

  /* ---------------- 预置文案库 ---------------- */
  const PHRASES = {
    greetMorning: [
      '早上好呀！今天也要元气满满哦～',
      '早安！我睁开眼第一件事就是想你～',
      '喵呜～早上好！早饭吃了吗？',
      '清晨的阳光和你一样温暖呢。'
    ],
    greetNoon: [
      '中午好！晒着太阳打个盹最舒服了～',
      '午安！记得好好吃饭哦。',
      '中午啦，饭点可别错过～'
    ],
    greetAfternoon: [
      '下午好呀～来杯下午茶怎么样？',
      '下午好！工作再忙也要记得休息哦。',
      '下午的时光最适合摸鱼…啊不，努力了！'
    ],
    greetEvening: [
      '晚上好！今天辛苦啦～',
      '晚上好呀，晚饭吃了吗？',
      '夜幕降临，我在这里陪你哦。'
    ],
    greetNight: [
      '夜深了呢…早点休息哦，晚安～',
      '这么晚了还不睡吗？我要先眯一会儿啦…',
      '熬夜伤身，快去睡觉，晚安啦。'
    ],
    onClick: [
      '嘿嘿，好痒呀～',
      '喵～找我玩吗？',
      '戳我干嘛呀，嘻嘻。',
      '再戳我就要打滚啦！',
      '好啦好啦，我知道你最疼我了～',
      '有什么事吗？',
      '嘿嘿，被你摸头了。',
      '陪你待着就很好呀。'
    ],
    onDragStart: [
      '呀！要飞起来了！',
      '抓紧我呀～',
      '要带我去哪里？',
      '呜哇——'
    ],
    onDragEnd: [
      '安全着陆！',
      '呼…刚才好高呀。',
      '谢谢接住我！',
      '屁股墩儿…好疼。',
      '放我下来也不提前说一声～'
    ],
    onFeed: [
      '好吃好吃！',
      '谢谢你投喂～',
      '唔姆唔姆…还想再来一口！',
      '这是我吃过最好吃的！',
      '满足～'
    ],
    onFeedFull: [
      '肚子圆滚滚的啦，吃不下了～',
      '再吃要变成球啦！',
      '谢谢，但我真的饱啦。'
    ],
    onHungry: [
      '肚子咕咕叫了…有吃的吗？',
      '好饿呀…小鱼干也行……',
      '饿了饿了，脑袋都转不动了。'
    ],
    onSleepy: [
      '眼皮好重…',
      '哈欠——好困呀……',
      '想睡觉了……'
    ],
    onSleep: [
      '晚安……Zzz',
      '我睡着啦，有事叫我……Zzz'
    ],
    onWake: [
      '呼啊——睡得好香！',
      '早上好！我是说…如果现在是早上的话。',
      '精神满满，复活啦！'
    ],
    onPat: [
      '好舒服呀～',
      '最喜欢摸摸头了！',
      '再摸一下，就一下！',
      '幸福得冒泡泡了～'
    ],
    onWalk: [
      '我去溜达溜达～',
      '散步时间！',
      '活动活动筋骨～'
    ],
    chat: [
      '今天天气看起来不错哦。',
      '你说，云朵是不是天空的棉花糖？',
      '我刚才梦到一条特别大的鱼！',
      '无聊的时候可以捏捏我的脸。',
      '悄悄告诉你，尾巴是最诚实的。',
      '听歌的时候记得叫上我。',
      '窗外的鸟儿在开会呢。',
      '今天的你也辛苦啦。',
      '要是有一罐小鱼干就好了……',
      '我在练习踩奶，进步很大哦。',
      '呼噜呼噜……啊不，我没有睡！',
      '你笑起来的样子很好看。',
      '月亮今晚很圆呢。',
      '喝口水吧，我看着你喝。',
      '保持好心情，运气会变好哦。',
      '偶尔偷个懒也没关系。',
      '我在呢，随时找我玩。',
      '刚数了三朵云，都像小鱼干。',
      '风把我的耳朵吹痒啦。',
      '要是一直这么悠闲就好了。'
    ],
    remindDrink: [
      '喝水时间到！起来接杯水吧～',
      '叮咚——记得喝水哦，皮肤会闪闪发光的。',
      '我帮你倒不了水，但我可以提醒你喝！'
    ],
    remindRest: [
      '看了好久屏幕啦，望望远处休息下眼睛吧。',
      '站起来伸个懒腰吧，我陪你。',
      '久坐提醒！活动一下脖子肩膀～'
    ]
  };

  /* ---------------- 气泡 ---------------- */
  let bubbleEl = null;
  let bubbleTimer = null;

  function ensureBubble() {
    if (!bubbleEl) bubbleEl = document.getElementById('speech-bubble');
    return bubbleEl;
  }

  function showBubble(text) {
    const el = ensureBubble();
    if (!el) return;
    el.textContent = text;
    el.classList.remove('hidden');
    // 重新触发弹出动画
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    if (bubbleTimer) clearTimeout(bubbleTimer);
    const dur = Math.min(6000, Math.max(2200, 1800 + text.length * 160));
    bubbleTimer = setTimeout(function () { el.classList.add('hidden'); }, dur);
  }

  /* ---------------- 本地 TTS 朗读 ---------------- */
  let ttsEnabled = true;
  let rate = 1.0;
  let voice = null;
  const ttsSupported = ('speechSynthesis' in window) && ('SpeechSynthesisUtterance' in window);

  function pickVoice() {
    try {
      const vs = window.speechSynthesis.getVoices();
      voice =
        vs.find(function (v) { return /zh[-_]CN/i.test(v.lang); }) ||
        vs.find(function (v) { return /^zh/i.test(v.lang); }) ||
        null;
    } catch (e) { voice = null; }
  }
  if (ttsSupported) {
    pickVoice();
    window.speechSynthesis.onvoiceschanged = pickVoice;
  }

  function speak(text) {
    if (!ttsEnabled || !ttsSupported) return;
    try {
      window.speechSynthesis.cancel();
      const u = new window.SpeechSynthesisUtterance(text);
      if (voice) u.voice = voice;
      u.lang = 'zh-CN';
      u.rate = rate;
      u.pitch = 1.15;
      window.speechSynthesis.speak(u);
    } catch (e) { /* 环境不支持时静默降级为纯气泡 */ }
  }

  /* ---------------- 对外接口 ---------------- */
  const lastSaidAt = {};   // 分类节流

  function applyTalkingAnimation(durationMs) {
    if (window.PetCore) {
      const st = window.PetCore.getAnimState();
      if (st === 'idle' || st === 'walking' || st === 'happy' || st === 'sleepy') {
        window.PetCore.setAnimState('talking', durationMs);
      }
    }
  }

  function say(category, opts) {
    const pool = PHRASES[category];
    if (!pool || !pool.length) return;

    /* 自定义语音包优先：有用户音频则播放音频，气泡显示用户台词（无则 ♪） */
    if (window.AudioSystem && window.AudioSystem.has && window.AudioSystem.has(category)) {
      const slot = window.AudioSystem.getSlot(category) || {};
      lastSaidAt[category] = Date.now();
      showBubble(slot.label || '♪～♪～');
      window.AudioSystem.play(category);
      applyTalkingAnimation(Math.max(1800, Math.min(5500, (slot.duration || 2) * 1000)));
      return;
    }

    const text = pool[Math.floor(Math.random() * pool.length)];
    sayText(text, opts);
    lastSaidAt[category] = Date.now();
  }

  function sayText(text, opts) {
    if (!text) return;
    opts = opts || {};
    // 同类内容节流，避免连点刷屏
    if (opts.category) {
      const last = lastSaidAt[opts.category] || 0;
      if (Date.now() - last < (opts.cooldown || 8000)) return;
      lastSaidAt[opts.category] = Date.now();
    }
    showBubble(text);
    speak(text);
    // 说话时切换 talking 动画（不打断进食/睡觉等重状态）
    applyTalkingAnimation(Math.max(1800, Math.min(5500, 1500 + text.length * 150)));
  }

  /* 面向技能的便捷调用：带分类节流 */
  function sayThrottled(category, cooldownMs) {
    const last = lastSaidAt[category] || 0;
    if (Date.now() - last < (cooldownMs || 8000)) return;
    say(category);
  }

  window.SpeechSystem = {
    say: say,
    sayText: sayText,
    sayThrottled: sayThrottled,
    random: function (category) {
      const pool = PHRASES[category];
      return pool ? pool[Math.floor(Math.random() * pool.length)] : '';
    },
    setTtsEnabled: function (v) { ttsEnabled = !!v; },
    setRate: function (v) { rate = Math.max(0.5, Math.min(2, Number(v) || 1)); },
    getTtsEnabled: function () { return ttsEnabled; },
    getRate: function () { return rate; },
    PHRASES: PHRASES
  };
})();
