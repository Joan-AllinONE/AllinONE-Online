/* ==========================================================
 * 技能：小吃货
 * 提供投喂动作按钮；宠物饿了会喊你，吃饱会有满足反馈。
 * （数值与进食动画由核心处理，本技能负责入口与语音反馈。）
 * ========================================================== */
PetSkills.register({
  id: 'feed',
  name: '小吃货',
  description: '提供投喂互动：宠物会喊饿，投喂让它心满意足。',
  icon: '🍽️',
  defaultEnabled: true,
  actions: [
    {
      id: 'feed',
      label: '喂食',
      icon: '🐟',
      onClick: function (ctx) {
        const ok = ctx.feed();
        if (!ok) ctx.sayText('唔姆…我还在吃呢！');
      }
    }
  ],
  setup: function (ctx) {
    ctx.on('pet:hungry', function () {
      ctx.sayText(window.SpeechSystem.random('onHungry'));
    });
    ctx.on('pet:feed:end', function () {
      const satiety = ctx.getStats().satiety;
      if (satiety > 92) ctx.sayText(window.SpeechSystem.random('onFeedFull'));
      else ctx.sayText(window.SpeechSystem.random('onFeed'));
    });
  }
});
