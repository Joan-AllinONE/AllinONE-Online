/**
 * QuestPublishGuide - 任务发布指南（任务广场顶部可折叠面板）
 *
 * 面向任意游戏的通用发布说明：
 *  - 四种扩展形态：数据型 / 代码脚本型 / 完整页面与片段 / 修复补文件
 *  - 每种形态说明「游戏侧需要做什么」与参考示例（超级玛丽、RPG 二创等）
 *  - 平台级踩坑总结（与具体游戏无关）
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { BookOpen, ChevronDown, ChevronUp, AlertTriangle, Lightbulb, Copy, Download, FileText } from 'lucide-react';
import { GAME_DEV_GUIDE_TEMPLATE, GAME_DEV_GUIDE_TEMPLATE_FILE } from './questDocTemplate';

/** 代码块（保持横向滚动 + 深色背景） */
function Code({ children }: { children: string }) {
  return (
    <pre className="mt-1 p-2 rounded-lg bg-slate-900 text-emerald-300 dark:bg-slate-950 text-xs overflow-x-auto leading-relaxed whitespace-pre">
      {children}
    </pre>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      <h4 className="text-sm font-bold text-slate-800 dark:text-slate-100 mb-1.5">{title}</h4>
      {children}
    </div>
  );
}

export default function QuestPublishGuide() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  /** 复制模板到剪贴板（优先 Clipboard API，失败回退 execCommand） */
  const copyTemplate = async () => {
    try {
      await navigator.clipboard.writeText(GAME_DEV_GUIDE_TEMPLATE);
      setCopied(true);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = GAME_DEV_GUIDE_TEMPLATE;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        (document as any).execCommand('copy');
        setCopied(true);
      } catch {
        /* 忽略复制失败 */
      }
      document.body.removeChild(ta);
    }
    window.setTimeout(() => setCopied(false), 2000);
  };

  /** 下载模板为 .md 文件 */
  const downloadTemplate = () => {
    const blob = new Blob([GAME_DEV_GUIDE_TEMPLATE], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = GAME_DEV_GUIDE_TEMPLATE_FILE;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mb-8">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-3.5 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-md hover:shadow-lg transition-all"
      >
        <span className="flex items-center gap-2 text-sm font-semibold">
          <BookOpen className="w-5 h-5" />
          任务发布指南
        </span>
        <span className="text-xs opacity-80 flex items-center gap-1">
          {open ? '收起' : '查看四种扩展形态与常见问题'}
          {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </span>
      </button>

      {open && (
        <div className="mt-3 p-5 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-sm text-slate-600 dark:text-slate-300 text-sm leading-relaxed">
          <Section title="核心原则">
            <p>
              平台<strong>不做源码 diff 合并</strong>：任务产物是一个「内容包」（ContentPack），
              审核合并后被追加到游戏的挂载点 slot。原游戏保持不变，产物是独立扩展。
              合并的 <strong>assets 文件</strong>会落库到扩展命名空间，平台会按「游戏内相对路径」自动回退命中（见模式 D）。
            </p>
            <p className="mt-1">
              <strong>零代码优先</strong>：数据型（模式 A）、补文件（模式 D）、以及引用游戏已内置的预设效果，
              这三类都不需要写代码。只有想表达「游戏数据模型解释不了的新行为」才需要模式 B 的脚本，可完全跳过。
            </p>
          </Section>

          <Section title="任务开发说明模板（游戏方用 · 保护源码）">
            <p>
              发布任务前，建议为你的游戏附一份「任务开发说明」：<strong>只公开接口与数据格式、不暴露源码</strong>，
              让没有代码基础的玩家能借助 AI 像完成游戏任务一样完成任务。
              （示例：《超级玛丽》《RPG 二创》各有一份，见各自游戏目录。）
            </p>
            <p className="mt-1">
              点击下方按钮复制或下载通用模板，替换 <code className="px-1 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-xs">&lt;占位符&gt;</code>{' '}
              为你的游戏信息与公开接口即可。
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={copyTemplate}
                className="px-3 py-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400 text-xs font-medium hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-colors flex items-center gap-1"
              >
                <Copy className="w-3.5 h-3.5" /> {copied ? '已复制 ✓' : '复制模板'}
              </button>
              <button
                type="button"
                onClick={downloadTemplate}
                className="px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-xs font-medium hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors flex items-center gap-1"
              >
                <Download className="w-3.5 h-3.5" /> 下载模板 (.md)
              </button>
              <span className="text-[11px] text-slate-400 flex items-center gap-1">
                <FileText className="w-3 h-3" /> 模板 = docs/游戏任务开发说明-模板.md
              </span>
            </div>
          </Section>

          <Section title="模式 A：数据型（关卡 / 配置 / 素材）">
            <p>
              提交 <strong>data</strong>（JSON 数组或对象）到目标 slot。适合关卡、道具定义、贴图音效等「纯数据」内容。
              游戏侧需要在启动时读取该 slot 并消费（游戏内置加载器）。
            </p>
            <p className="mt-1">
              参考示例：超级玛丽把关卡数据放进 <code className="px-1 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-xs">levels</code>{' '}
              slot，游戏侧 <code className="px-1 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-xs">QuestAPI.getSlotData('levels')</code>{' '}
              读取并按字符网格重建关卡：
            </p>
            <Code>{`[
  { "id": "lvl2", "title": "第二关", "cols": 150,
    "layout": "15行字符网格（#地面 B砖 ?金币 M蘑菇 X硬块 C金币 F旗杆）",
    "enemyCols": [25, 45] }
]`}</Code>
            <p className="mt-1">贴图 / 音效可作为 assets 上传（png/jpg/mp3），data 里用相对路径引用。</p>
          </Section>

          <Section title="模式 B：进阶·自定义新行为（可选，需写脚本）">
            <p>
              <strong>不会写代码的玩家请忽略本模式</strong>——模式 A（数据）和模式 D（补文件）已覆盖绝大多数需求。
              本模式只服务于「游戏内置的数据/预设效果表达不了的全新行为」：提交 data 里的脚本字段（如{' '}
              <code className="px-1 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-xs">script</code>）指向 assets 中的{' '}
              <code className="px-1 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-xs">.js</code> 文件。
              <strong>游戏侧需约定脚本接口</strong>（用 Blob URL + script 标签沙箱加载，非裸 eval），并按需调用。
            </p>
            <p className="mt-1">
              示例① 超级玛丽：脚本暴露 <code className="px-1 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-xs">window.MarioLevel.build(api)</code>：
            </p>
            <Code>{`// data
[{ "id": "lvl2", "title": "第二关：空中花园", "cols": 150, "script": "level2.js" }]

// assets 上传 level2.js
window.MarioLevel = { build(api){
  api.setT(8,9,3); api.pipe(22,11);
  api.stairUp(64,4); api.stairDown(116,6);
  api.setFlag(138); api.setEnemies([15,28,47]);
} }`}</Code>
            <p className="mt-1">
              示例② RPG 二创：走内置 UGC 道具机制（effectCode / <code className="px-1 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-xs">window.__ALLINONE_EFFECT_DEFS</code>{' '}
              自注册），提交道具 JSON 即可，无需改游戏代码。
            </p>
          </Section>

          <Section title="模式 C：完整页面 / HTML 片段">
            <p>
              上传 HTML 并填 <strong>entryPoint</strong>（如 level2.html）。若只是<strong>片段</strong>（非完整页面），
              勾选「HTML 片段」→ 平台合并时自动用统一壳包裹成完整页面。
            </p>
          </Section>

          <Section title="模式 D：修复 / 补回文件（零代码）">
            <p className="font-semibold text-slate-700 dark:text-slate-200">
              补回被删 / 缺失的文件 = <strong>只需上传文件 + data 留空对象即可</strong>，全程不需要写任何代码。
            </p>
            <p className="mt-1">
              适合「原游戏引用了某文件但文件缺失 / 被删」的场景，例如 RPG 二创的{' '}
              <code className="px-1 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-xs">index.html</code> 引用了{' '}
              <code className="px-1 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-xs">js/gun.js</code> 但文件被删。
            </p>
            <p className="mt-1">
              提交时 <strong>data 留空对象即可</strong>（平台已支持「空 data + 有 assets」的纯文件补丁，任何 slot 都能提交，
              不再强制填 name 等必填字段）；任务类型建议选 <strong>fix</strong>。assets 的{' '}
              <strong>path 填游戏内相对路径</strong>（如 <code className="px-1 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-xs">js/gun.js</code>），
              上传列表里可直接点击路径修改。
            </p>
            <Code>{`// data：留空对象即可，无需任何字段
{}

// assets 上传文件，path 填游戏内原路径（目录要写全）
[{ "path": "js/gun.js", "content": "...原枪系统代码..." }]`}</Code>
            <p className="mt-1">
              合并后文件落库到扩展命名空间，平台文件分发自动<strong>回退匹配</strong>：浏览器请求{' '}
              <code className="px-1 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-xs">js/gun.js</code>（根目录没有）时命中扩展资产。
              回退支持三级：完整路径 → 尾部路径 → <strong>文件名兜底</strong>——即使上传时 path 只写了{' '}
              <code className="px-1 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-xs">gun.js</code>（丢了 js/ 前缀）也能命中；
              同名文件多时取最新一次合并，建议仍补全目录。<strong>游戏零改动</strong>即可恢复。
            </p>
          </Section>

          <Section title="模式 E：注入脚本 / MOD（无需游戏改版）">
            <p>
              <strong>游戏内置加载器表达不了、又不方便改游戏文件时</strong>，用注入模式：勾选「注入模式」后，
              平台把脚本（<code className="px-1 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-xs">data.code</code> 或
              assets 的 <code className="px-1 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-xs">.js</code> 文件）
              写入 <code className="px-1 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-xs">published_games.injections</code>。
              玩家打开游戏入口 HTML 时自动<strong>拼接执行</strong>——任何游戏零改动即可生效。
            </p>
            <p className="mt-1 font-semibold text-slate-700 dark:text-slate-200">
              典型场景：超级玛丽第三关 MOD（200 列地图 + 坑洞 + 乌龟/食人花 + 夜色 + 蝙蝠），
              只需把 <code className="px-1 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-xs">超级玛丽-第三关MOD.js</code>{' '}
              作为 assets 上传并勾选注入模式。
            </p>
            <Code>{`// data：可留空 {}（脚本优先取第一个 .js 资产；也可用 data.code 直接内联）
{ "code": "// 可选：直接写脚本源码" }

// assets 上传 .js 文件（首个 .js 作注入脚本）；css/图片/音频/字体可一并上传
[
  { "path": "超级玛丽-第三关MOD.js", "content": "/* 你的 MOD 源码 */" },
  { "path": "style.css", "content": "body{background:url(bg.png)}" },  // 平台自动以 <link> 注入，无需写代码
  { "path": "bg.png", "content": "/* base64 图片 */" },
  { "path": "bgm.mp3", "content": "/* base64 音频 */" }
]`}</Code>
            <p className="mt-1">
              <strong>脚本里引用上传的资源：</strong>用 <code className="px-1 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-xs">AllinONE_asset('文件名')</code>{' '}
              返回可加载 URL（图片/声音/字体等）；CSS 文件会自动以 &lt;link&gt; 注入，其中 <code className="px-1 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-xs">url(bg.png)</code>{' '}
              相对 CSS 自身解析，天然指向你的资源。
            </p>
            <Code>{`// ① CSS 皮肤：style.css 上传后自动生效，无需任何代码
// ② 图片：
const img = new Image();
img.src = AllinONE_asset('bg.png');
// ③ 声音：
new Audio(AllinONE_asset('bgm.mp3')).play();
// ④ 也可引用游戏原有文件（相对入口 HTML）：
fetch('js/mario.js').then((r) => r.text()).then((code) => eval(code));`}</Code>
            <p className="mt-1">
              ⚠️ 高风险：代码会在玩家浏览器里运行。请只做关卡 / 平衡 / 功能增强，勿触碰账号 / 凭证 / 钱包数据。
              平台对注入型任务跳过危险代码扫描（代码即交付物），安全靠审核 + 权限管控。
            </p>
          </Section>

          <Section title="提交格式速查（通用）">
            <Code>{`{
  "slot": "levels | scripts | fix | items | skins | audio | art | inject | <自定义>",
  "data": <随 slot 语义的结构化内容>,
  "assets": [ { "path": "游戏内相对路径", "content": "文件内容" } ],
  "entryPoint": "独立入口文件名（模式 C 用）",
  "fragment": true,   // entryPoint 是片段时勾选
  "inject": true      // 模式 E：脚本注入宿主游戏页面（模式 E 勾选）
}`}</Code>
          </Section>

          <Section title="常见问题（踩坑总结）">
            <ul className="space-y-2">
              <li className="flex gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <span>
                  <strong>提交报「文件 xxx.js 类型不允许（允许: json）」</strong>：服务端校验用的是旧编译产物。本地重启后端
                  （<code className="px-1 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-xs">tsc -p tsconfig.server.json</code> + 重启）；线上需重新部署云函数后重试。
                </span>
              </li>
              <li className="flex gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <span>
                  <strong>合并成功但游戏没变化</strong>：① 改造后的游戏 HTML 需重新发布（文件进后端/云存储）；
                  ② 浏览器强刷 <code className="px-1 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-xs">Ctrl+Shift+R</code> 清 Service Worker 缓存
                  （DevTools → Application → Service Workers → Unregister 更彻底）。
                </span>
              </li>
              <li className="flex gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <span>
                  <strong>游戏内显示「0 个扩展关卡 / 扩展没出现」</strong>：确认任务已合并（状态 merged）且挂载点 slot 与任务
                  contentSlot 一致。若数据是早期版本合并的嵌套结构，游戏端已自动兼容。
                </span>
              </li>
              <li className="flex gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <span>
                  <strong>游戏报「游戏文件不可用 503」</strong>：后端离线或文件未同步到后端。启动后端服务后先在线打开一次游戏
                  （Service Worker 会缓存文件），再离线也能玩。
                </span>
              </li>
              <li className="flex gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <span>
                  <strong>注入模式合并后游戏没变化</strong>：先强刷（Ctrl+Shift+R）让新版 Service Worker（v13+）接管——
                  DevTools → Application → Service Workers → Unregister 更彻底；再确认任务已 merged。
                </span>
              </li>
              <li className="flex gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <span>
                  <strong>从「扩展 (N)」菜单进入后没有自动打开扩展</strong>：数据/脚本类扩展（无独立 HTML 入口）需要在游戏内
                  选择。最新版游戏已支持「从扩展菜单进入 → 自动选中」，强刷后生效。
                </span>
              </li>
              <li className="flex gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <span>
                  <strong>补文件后仍加载失败</strong>：先确认任务已合并（状态 merged）；其次 assets 的 path 尽量与 index.html
                  引用一致（含目录，如 <code className="px-1 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-xs">js/gun.js</code>）
                  ——平台已支持文件名兜底（只传 gun.js 也能命中），同名文件多时建议补全目录；最后强刷页面清 SW 缓存。
                </span>
              </li>
            </ul>
          </Section>

          <Section title="发布前检查清单">
            <ul className="space-y-1">
              <li className="flex gap-2">
                <Lightbulb className="w-4 h-4 text-indigo-500 shrink-0 mt-0.5" />
                contentSlot 与提交内容匹配：关卡 → levels；脚本/能力 → scripts；修复补文件 → fix；音效 → audio；美术 → art。
              </li>
              <li className="flex gap-2">
                <Lightbulb className="w-4 h-4 text-indigo-500 shrink-0 mt-0.5" />
                assets 的 path 用「游戏内相对路径」（不含 /api/v1/games/... 前缀）。
              </li>
              <li className="flex gap-2">
                <Lightbulb className="w-4 h-4 text-indigo-500 shrink-0 mt-0.5" />
                补文件类任务：data 留空即可，上传文件 + path 填游戏内相对路径；任何 slot 都支持「空 data + 有 assets」纯文件补丁。
              </li>
              <li className="flex gap-2">
                <Lightbulb className="w-4 h-4 text-indigo-500 shrink-0 mt-0.5" />
                文件大小上限默认 512KB（可在任务 acceptance 调整）。
              </li>
              <li className="flex gap-2">
                <Lightbulb className="w-4 h-4 text-indigo-500 shrink-0 mt-0.5" />
                非独立入口的 .js 会做危险代码扫描：避免出现 eval( / new Function / &lt;script 等字样。
              </li>
              <li className="flex gap-2">
                <Lightbulb className="w-4 h-4 text-indigo-500 shrink-0 mt-0.5" />
                审核通过并合并后，扩展才会出现在游戏的「扩展 (N)」菜单与对应加载器。
              </li>
            </ul>
          </Section>
        </div>
      )}
    </div>
  );
}
