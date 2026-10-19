/* ==========================================================
 * 技能：作息管理
 * 提供睡觉/唤醒按钮；夜里 22:30 后自动入睡，早晨 6:30 自动醒来。
 * ========================================================== */
PetSkills.register({
  id: 'sleep',
  name: '作息管理',
  description: '可哄它睡觉恢复精力；深夜自动入睡、清晨自动醒来。',
  icon: '😴',
  defaultEnabled: true,
  actions: [
    {
      id: 'sleep-toggle',
      label: '睡觉/唤醒',
      icon: '🌙',
      onClick: function (ctx) {
        const st = ctx.getAnimState();
        if (st === 'sleeping') ctx.wake();
        else ctx.sleep();
      }
    }
  ],
  setup: function (ctx) {
    ctx.on('pet:sleepy', function () { ctx.sayText(window.SpeechSystem.random('onSleepy')); });
    ctx.on('pet:sleep', function () { ctx.sayText(window.SpeechSystem.random('onSleep')); });
    ctx.on('pet:wake', function () { ctx.sayText(window.SpeechSystem.random('onWake')); });

    // 每分钟检查一次作息时间（22:30 睡，6:30 醒）
    let checkCounter = 0;
    ctx.on('tick', function () {
      checkCounter++;
      if (checkCounter % 60 !== 0) return;
      const d = new Date();
      const mins = d.getHours() * 60 + d.getMinutes();
      const st = ctx.getAnimState();
      if (mins >= 22 * 60 + 30 || mins < 6 * 60 + 30) {
        if (st !== 'sleeping') ctx.sleep();
      }
    });
  }
});
