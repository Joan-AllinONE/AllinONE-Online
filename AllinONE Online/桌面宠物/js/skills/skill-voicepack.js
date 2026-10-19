/* ==========================================================
 * 技能：自定义语音包
 * 开启后，事件触发时优先播放用户上传/录制的音频（替代 TTS）；
 * 关闭后回到默认 TTS 朗读。语音槽位管理入口在设置面板
 * 「自定义语音包」分组（由 main.js 渲染，逻辑在 audio.js）。
 * ========================================================== */
PetSkills.register({
  id: 'voicepack',
  name: '自定义语音包',
  description: '用麦克风录制或上传音频，绑定到宠物的事件回应（问候/被点击/被投喂等），触发时优先播放你的声音。',
  icon: '🎤',
  defaultEnabled: true,
  setup: function (ctx) {
    window.AudioSystem.setEnabled(true);
    ctx.onCleanup(function () {
      window.AudioSystem.setEnabled(false);
    });
  }
});
