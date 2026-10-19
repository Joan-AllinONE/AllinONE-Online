/* ==========================================================
 * 技能：摸摸头
 * 双击宠物给它摸摸头，它会特别开心（爱心 + 好心情）。
 * ========================================================== */
PetSkills.register({
  id: 'pat',
  name: '摸摸头',
  description: '双击宠物即可摸摸头，它会幸福得冒泡泡。',
  icon: '✋',
  defaultEnabled: true,
  setup: function (ctx) {
    ctx.on('pet:dblclick', function () {
      ctx.sayText(window.SpeechSystem.random('onPat'));
      if (window.PetFX) window.PetFX.spawn('heart', 6);
    });
  }
});
