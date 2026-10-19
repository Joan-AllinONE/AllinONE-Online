/* ==========================================================
 * 技能：健康小助手
 * 定时提醒喝水 / 远眺休息（间隔可在此调整，默认 45 分钟）。
 * ========================================================== */
PetSkills.register({
  id: 'remind',
  name: '健康小助手',
  description: '每 45 分钟提醒你喝水、远眺、活动身体。',
  icon: '⏰',
  defaultEnabled: true,
  setup: function (ctx) {
    const INTERVAL_MINUTES = 45;   // 提醒间隔（分钟），可按需调整
    let timer = null;
    let round = 0;

    function remind() {
      round++;
      const useDrink = (round % 2 === 1); // 喝水与休息交替提醒
      const category = useDrink ? 'remindDrink' : 'remindRest';
      const st = ctx.getAnimState();
      if (st !== 'sleeping') {
        ctx.sayText(window.SpeechSystem.random(category));
      }
      // 通知条（即使语音关闭也能看到）
      if (window.PetUI && window.PetUI.toast) {
        window.PetUI.toast(useDrink ? '💧 喝水提醒：起来接杯水吧' : '👀 休息提醒：望望远处放松眼睛');
      }
      schedule();
    }

    function schedule() {
      timer = setTimeout(remind, INTERVAL_MINUTES * 60 * 1000);
    }

    schedule();
    ctx.onCleanup(function () { if (timer) clearTimeout(timer); });
  }
});
