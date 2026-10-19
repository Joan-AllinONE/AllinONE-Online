/* ==========================================================
 * 技能：话痨
 * 每隔 1.5～4 分钟随机说一句预置闲聊语句，心情越好越爱说话。
 * ========================================================== */
PetSkills.register({
  id: 'chat',
  name: '话痨闲聊',
  description: '空闲时随机冒出一句闲聊，屏幕前的你不孤单。',
  icon: '💬',
  defaultEnabled: true,
  setup: function (ctx) {
    let timer = null;

    function schedule() {
      const mood = ctx.getStats().mood;
      // 心情好时更活泼（间隔更短）
      const base = mood > 70 ? 90000 : mood > 40 ? 150000 : 240000;
      const delay = base + Math.random() * 90000;
      timer = setTimeout(function () {
        const st = ctx.getAnimState();
        if (st !== 'sleeping' && st !== 'dragging' && st !== 'eating') {
          ctx.sayText(window.SpeechSystem.random('chat'));
        }
        schedule();
      }, delay);
    }

    schedule();
    ctx.onCleanup(function () { if (timer) clearTimeout(timer); });
  }
});
