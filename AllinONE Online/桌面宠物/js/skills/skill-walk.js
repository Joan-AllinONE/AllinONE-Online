/* ==========================================================
 * 技能：边缘漫步
 * 待久了无聊时，宠物会自己在屏幕底部走来走去，更有生气。
 * ========================================================== */
PetSkills.register({
  id: 'walk',
  name: '边缘漫步',
  description: '待机无聊时在屏幕边缘散步溜达，走路说话两不误。',
  icon: '🚶',
  defaultEnabled: true,
  setup: function (ctx) {
    ctx.on('pet:bored', function () {
      const stats = ctx.getStats();
      const st = ctx.getAnimState();
      if (stats.energy > 25 && (st === 'idle' || st === 'sleepy')) {
        ctx.startWalking(5 + Math.random() * 7);
      }
    });
    ctx.on('pet:walk:start', function () {
      if (Math.random() < 0.7) ctx.sayThrottled('onWalk', 60000);
    });
  }
});
