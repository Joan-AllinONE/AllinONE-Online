/* ==========================================================
 * 技能：时光问候
 * 启动时根据当前时间打招呼，早晚安不缺席。
 * ========================================================== */
PetSkills.register({
  id: 'greet',
  name: '时光问候',
  description: '启动时按时间问候：早安、午安、晚安都不缺席。',
  icon: '👋',
  defaultEnabled: true,
  setup: function (ctx) {
    ctx.on('app:start', function () {
      const h = new Date().getHours();
      let category;
      if (h >= 5 && h < 9) category = 'greetMorning';
      else if (h >= 9 && h < 12) category = 'greetNoon';
      else if (h >= 12 && h < 14) category = 'greetNoon';
      else if (h >= 14 && h < 18) category = 'greetAfternoon';
      else if (h >= 18 && h < 23) category = 'greetEvening';
      else category = 'greetNight';
      setTimeout(function () { ctx.sayText(window.SpeechSystem.random(category)); }, 900);
    });
  }
});
