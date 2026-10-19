/* ==========================================================
 * 技能：点击回应（基础互动）
 * 单击 / 拖拽结束时给出基础语音反馈。
 * 集中负责通用 onClick / onDragEnd 文案，扩展新技能可继续挂载 pet:click
 * 监听以添加更复杂的反应。
 * ========================================================== */
PetSkills.register({
  id: 'click-respond',
  name: '点击回应',
  description: '被点击和拖拽时给出基础语音反馈。',
  icon: '👆',
  defaultEnabled: true,
  setup: function (ctx) {
    ctx.on('pet:click', function () {
      ctx.sayThrottled('onClick', 3500);
    });
    ctx.on('pet:dragend', function () {
      ctx.sayThrottled('onDragEnd', 6000);
    });
    ctx.on('pet:dragstart', function () {
      ctx.sayThrottled('onDragStart', 8000);
    });
  }
});
