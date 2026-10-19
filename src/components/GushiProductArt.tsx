/**
 * GushiProductArt — 缅川公盘（翡翠赌石）成品凭证「作品图」渲染
 *
 * 与 perler-artwork 同模式：游戏侧在 ITEM_HARVEST 的 itemData.params 里带上
 * 确定性视觉参数（craft/gem/seed/size，合计 <100 字节，远低于 8KB 限制），
 * 平台侧用与游戏一致的程序化绘制引擎重绘成品图（同一 seed 必绘出同一张图），
 * 市场卡片在任何浏览器都能显示，无需依赖游戏文件或图片资产。
 *
 * ⚠️ 绘制引擎移植自 AllinONE Online/赌石小游戏/index.html 的 drawProduct
 * （含 GEMS/jadeCol/mulberry32/shade），两侧必须保持参数与算法一致：
 * 改游戏侧绘制时需同步本文件，反之亦然。
 */
import { useEffect, useRef } from 'react';

/** 种水定义（与游戏 GEMS 表一致） */
const GEMS: Array<{ id: string; name: string; color: string; jade: string; idx: number }> = [
  { id: 'rock', name: '垮石杂料', color: '#9a9a9a', jade: '#8f8f8b', idx: 0 },
  { id: 'dou', name: '豆种翡翠', color: '#7bc47f', jade: '#6fa76a', idx: 1 },
  { id: 'nuo', name: '糯种翡翠', color: '#3ddc84', jade: '#3ea562', idx: 2 },
  { id: 'bing', name: '冰种翡翠', color: '#7ec8e3', jade: '#9fd8bd', idx: 3 },
  { id: 'boli', name: '玻璃种翡翠', color: '#c9a7f5', jade: '#cfeee0', idx: 4 },
  { id: 'diwang', name: '帝王绿', color: '#ffd94d', jade: '#0d8a4a', idx: 5 },
];

const gemOf = (id: string) => GEMS.find(g => g.id === id);
/** 玉料真实色（区别于 UI 图标色） */
const jadeCol = (g: { jade: string; color: string }) => g.jade || g.color;

/** 与游戏一致的确定性 PRNG（mulberry32） */
function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 颜色明暗调整（与游戏 shade 一致） */
function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.max(0, (n >> 16) + amt));
  const g = Math.min(255, Math.max(0, ((n >> 8) & 255) + amt));
  const b = Math.min(255, Math.max(0, (n & 255) + amt));
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

/**
 * 程序化绘制成品图（写实抛光/雕刻/透光工艺）。
 * 参数与游戏 drawProduct(type, gemId, seed, size, px) 完全一致。
 */
export function drawGushiProduct(
  type: string, gemId: string, seed: number, size: number | undefined, px = 480,
): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = px; cv.height = px;
  const c = cv.getContext('2d') as CanvasRenderingContext2D;
  const W = px;
  const gem = gemOf(gemId) || GEMS[1];
  const idx = gem.idx;
  const col = jadeCol(gem);
  const rng = mulberry32(Math.floor(seed) ^ (type.length * 7919));

  /* 天鹅绒衬布背景 */
  const bg = c.createRadialGradient(W / 2, W * 0.42, W * 0.1, W / 2, W / 2, W * 0.72);
  bg.addColorStop(0, '#233226'); bg.addColorStop(1, '#0a0f0c');
  c.fillStyle = bg; c.fillRect(0, 0, W, W);
  for (let i = 0; i < 50; i++) { /* 绒布纤维微光 */
    c.fillStyle = `rgba(120,160,130,${0.02 + rng() * 0.03})`;
    c.fillRect(rng() * W, rng() * W, 1.5, 1.5);
  }

  /* 通用玉料渲染：底色+云雾+色根+棉+内透光，path 内裁剪 */
  function paintJade(pathFn: (ctx: CanvasRenderingContext2D) => void, o: { rule?: CanvasFillRule } = {}) {
    c.save(); c.beginPath(); pathFn(c);
    if (o.rule) c.clip(o.rule); else c.clip();
    const g = c.createLinearGradient(0, 0, W, W);
    g.addColorStop(0, shade(col, 34)); g.addColorStop(0.45, col); g.addColorStop(1, shade(col, -48));
    c.fillStyle = g; c.fillRect(0, 0, W, W);
    for (let i = 0; i < 22; i++) { /* 玉肉云雾 */
      const x = rng() * W, y = rng() * W, r = W * 0.03 + rng() * W * 0.1;
      const gg = c.createRadialGradient(x, y, 1, x, y, r);
      gg.addColorStop(0, (rng() < 0.5 ? shade(col, 28) : shade(col, -26)) + '30');
      gg.addColorStop(1, 'transparent');
      c.fillStyle = gg; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
    }
    if (idx >= 2) { /* 色根条带（浓绿走脉） */
      for (let i = 0; i < idx * 2; i++) {
        let x = rng() * W, y = rng() * W;
        c.strokeStyle = 'rgba(8,80,38,.42)';
        c.lineWidth = W * 0.012 + rng() * W * 0.02; c.lineCap = 'round';
        c.beginPath(); c.moveTo(x, y);
        const pts: Array<[number, number]> = [[x, y]];
        for (let s2 = 0; s2 < 3; s2++) { x += (rng() - 0.3) * W * 0.22; y += (rng() - 0.5) * W * 0.18; pts.push([x, y]); }
        pts.forEach((p, j) => { if (j) c.lineTo(p[0], p[1]); });
        c.stroke();
        c.strokeStyle = 'rgba(140,255,170,.3)'; c.lineWidth = W * 0.004;
        c.beginPath();
        pts.forEach((p, j) => { if (j) c.lineTo(p[0] - 2, p[1] - 2); else c.moveTo(p[0] - 2, p[1] - 2); });
        c.stroke();
      }
    }
    if (idx >= 3) { /* 雪花棉 */
      for (let i = 0; i < 40; i++) {
        c.fillStyle = `rgba(255,255,255,${0.2 + rng() * 0.35})`;
        c.beginPath(); c.arc(rng() * W, rng() * W, W * 0.0015 + rng() * W * 0.004, 0, 7); c.fill();
      }
    }
    /* 内部透光（种水越高越透亮） */
    const ig = c.createRadialGradient(W / 2, W * 0.4, W * 0.02, W / 2, W / 2, W * 0.5);
    ig.addColorStop(0, `rgba(235,255,240,${0.05 + idx * 0.045})`); ig.addColorStop(1, 'transparent');
    c.fillStyle = ig; c.fillRect(0, 0, W, W);
    c.restore();
  }

  /* 抛光高光弧 */
  function glossArc(cx: number, cy: number, r: number, a0: number, a1: number, w: number, alpha: number) {
    c.save(); c.strokeStyle = `rgba(255,255,255,${alpha})`; c.lineWidth = w; c.lineCap = 'round';
    c.beginPath(); c.arc(cx, cy, r, a0, a1); c.stroke();
    c.strokeStyle = `rgba(255,255,255,${alpha * 0.45})`; c.lineWidth = w * 0.4;
    c.beginPath(); c.arc(cx, cy, r - w * 0.75, a0 + 0.12, a1 - 0.1); c.stroke();
    c.restore();
  }

  /* 地面柔影 */
  function shadow(cx: number, cy: number, rx: number, ry: number) {
    const sg = c.createRadialGradient(cx, cy, 2, cx, cy, rx);
    sg.addColorStop(0, 'rgba(0,0,0,.5)'); sg.addColorStop(1, 'transparent');
    c.save(); c.translate(cx, cy); c.scale(1, ry / rx); c.translate(-cx, -cy);
    c.fillStyle = sg; c.beginPath(); c.arc(cx, cy, rx, 0, 7); c.fill(); c.restore();
  }

  const sz = size || 1;

  if (type === 'bracelet' || type === 'pingan') {
    const main = type === 'bracelet';
    const cx = W / 2, cy = W * (main ? 0.48 : 0.5);
    const R = W * (main ? 0.3 : 0.2) * (0.85 + 0.3 * sz), r = R * (main ? 0.45 : 0.42);
    shadow(cx, cy + R * 0.92, R * 1.05, R * 0.22);
    const ring = (ctx: CanvasRenderingContext2D) => {
      ctx.moveTo(cx + R, cy); ctx.arc(cx, cy, R, 0, 7, false);
      ctx.moveTo(cx + r, cy); ctx.arc(cx, cy, r, 0, 7, false);
    };
    paintJade(ring, { rule: 'evenodd' });
    /* 环面立体感：外缘暗环+内缘亮环 */
    c.save(); c.beginPath(); ring(c); c.clip('evenodd');
    const tR = c.createRadialGradient(cx, cy, r, cx, cy, R);
    tR.addColorStop(0, 'rgba(255,255,255,.14)'); tR.addColorStop(0.55, 'rgba(255,255,255,0)'); tR.addColorStop(1, 'rgba(0,20,10,.42)');
    c.fillStyle = tR; c.fillRect(0, 0, W, W); c.restore();
    /* 透光边：轮廓内侧一线水头 */
    c.save(); c.beginPath(); c.arc(cx, cy, R - 3, 0, 7); c.strokeStyle = shade(col, 64) + '88'; c.lineWidth = 3.2; c.stroke();
    c.beginPath(); c.arc(cx, cy, r + 3, 0, 7); c.strokeStyle = shade(col, 58) + '77'; c.lineWidth = 2.6; c.stroke(); c.restore();
    /* 抛光长高光（左上）+ 对射弱高光（右下） */
    glossArc(cx, cy, (R + r) / 2, Math.PI * 1.08, Math.PI * 1.62, R * 0.14, main ? 0.5 : 0.55);
    glossArc(cx, cy, (R + r) / 2, -0.15, 0.42, R * 0.09, 0.22);
  } else if (type === 'plaque') {
    const pw = W * 0.4, ph = W * 0.54, cx = W / 2, cy = W * 0.47;
    shadow(cx, cy + ph * 0.56, pw * 0.62, ph * 0.1);
    const rr = W * 0.05;
    const plate = (ctx: CanvasRenderingContext2D) => {
      if (ctx.roundRect) ctx.roundRect(cx - pw / 2, cy - ph / 2, pw, ph, rr);
      else ctx.rect(cx - pw / 2, cy - ph / 2, pw, ph);
    };
    paintJade(plate);
    /* 牌缘起线（double 边框：外粗内细，仿工） */
    c.save(); c.beginPath(); plate(c); c.clip();
    c.strokeStyle = 'rgba(6,60,30,.5)'; c.lineWidth = 3.5;
    c.strokeRect(cx - pw / 2 + W * 0.022, cy - ph / 2 + W * 0.022, pw - W * 0.044, ph - W * 0.044);
    c.strokeStyle = shade(col, 52) + '66'; c.lineWidth = 1.4;
    c.strokeRect(cx - pw / 2 + W * 0.03, cy - ph / 2 + W * 0.03, pw - W * 0.06, ph - W * 0.06);
    /* 俏色山水浮雕：远山剪影+近坡+江水+小日（填充式浮雕，非线条） */
    function carve(fn: (ctx: CanvasRenderingContext2D, mode: string) => void, depth: number) {
      c.save(); c.translate(-depth, -depth); c.globalAlpha = 0.5 + 0.25 * depth;
      c.fillStyle = 'rgba(6,55,28,1)'; fn(c, 'dark'); c.restore();
      c.save(); c.translate(depth * 0.6, depth * 0.6); c.globalAlpha = 0.28;
      c.fillStyle = 'rgba(225,255,238,1)'; fn(c, 'lite'); c.restore();
    }
    const mountains = (cc: CanvasRenderingContext2D) => {
      cc.beginPath();
      cc.moveTo(cx - pw * 0.42, cy + ph * 0.16);
      cc.quadraticCurveTo(cx - pw * 0.18, cy - ph * 0.3, cx + pw * 0.02, cy + ph * 0.14);
      cc.quadraticCurveTo(cx + pw * 0.2, cy - ph * 0.12, cx + pw * 0.42, cy + ph * 0.16);
      cc.closePath(); cc.fill();
      cc.beginPath();
      cc.moveTo(cx + pw * 0.05, cy + ph * 0.16);
      cc.quadraticCurveTo(cx + pw * 0.28, cy - ph * 0.02, cx + pw * 0.42, cy + ph * 0.16);
      cc.closePath(); cc.fill();
      cc.beginPath(); cc.arc(cx + pw * 0.24, cy - ph * 0.24, ph * 0.045, 0, 7); cc.fill();
      cc.beginPath();
      cc.moveTo(cx - pw * 0.42, cy + ph * 0.3);
      cc.quadraticCurveTo(cx, cy + ph * 0.2, cx + pw * 0.42, cy + ph * 0.3);
      cc.quadraticCurveTo(cx, cy + ph * 0.24, cx - pw * 0.42, cy + ph * 0.3);
      cc.closePath(); cc.fill();
    };
    carve(mountains, 0.045);
    /* 穿绳孔 */
    c.beginPath(); c.arc(cx, cy - ph / 2 + W * 0.038, W * 0.016, 0, 7);
    c.fillStyle = 'rgba(0,0,0,.55)'; c.fill();
    c.beginPath(); c.arc(cx - W * 0.004, cy - ph / 2 + W * 0.034, W * 0.016, 0, 7);
    c.strokeStyle = shade(col, 60) + '99'; c.lineWidth = 1.5; c.stroke();
    c.restore();
    /* 抛光高光 */
    glossArc(cx, cy - ph * 0.18, pw * 0.34, Math.PI * 1.05, Math.PI * 1.55, W * 0.035, 0.4);
  } else if (type === 'jiemian') {
    const cx = W / 2, cy = W * 0.5, rx = W * 0.17 * (0.9 + 0.25 * sz), ry = rx * 0.78;
    shadow(cx, cy + ry * 0.95, rx * 1.1, ry * 0.24);
    const egg = (ctx: CanvasRenderingContext2D) => { ctx.ellipse(cx, cy, rx, ry, -0.2, 0, 7); };
    paintJade(egg);
    c.save(); c.beginPath(); egg(c); c.clip();
    /* 蛋面弧度：底部收暗 */
    const dg = c.createRadialGradient(cx - rx * 0.25, cy - ry * 0.3, rx * 0.1, cx, cy, rx * 1.25);
    dg.addColorStop(0, 'rgba(255,255,255,.2)'); dg.addColorStop(0.6, 'rgba(255,255,255,0)'); dg.addColorStop(1, 'rgba(0,25,12,.5)');
    c.fillStyle = dg; c.fillRect(0, 0, W, W); c.restore();
    /* 蛋面镜面高光：一手抹亮的弧面反光 */
    c.save(); c.translate(-rx * 0.3, -ry * 0.35); c.rotate(-0.5); c.scale(1, 0.45);
    const hg = c.createRadialGradient(0, 0, 1, 0, 0, rx * 0.5);
    hg.addColorStop(0, 'rgba(255,255,255,.85)'); hg.addColorStop(0.6, 'rgba(255,255,255,.15)'); hg.addColorStop(1, 'transparent');
    c.fillStyle = hg; c.beginPath(); c.arc(0, 0, rx * 0.5, 0, 7); c.fill(); c.restore();
    c.beginPath(); egg(c); c.strokeStyle = shade(col, 55) + '88'; c.lineWidth = 2.4; c.stroke();
  } else if (type === 'beads') {
    const n = 7, cx = W / 2, cy = W * 0.46, arcR = W * 0.3;
    shadow(cx, cy + arcR * 0.86, arcR * 1.1, W * 0.06);
    const br = W * 0.062 * (0.9 + 0.25 * sz);
    for (let i = 0; i < n; i++) {
      const a = Math.PI * (0.15 + (0.7 * i) / (n - 1)); /* 悬垂珠链弧 */
      const x = cx + Math.cos(a + Math.PI) * arcR, y = cy + Math.sin(a) * arcR * 0.5 + cy * 0.12;
      const bead = (ctx: CanvasRenderingContext2D) => { ctx.arc(x, y, br, 0, 7); };
      paintJade(bead);
      const bg2 = c.createRadialGradient(x - br * 0.35, y - br * 0.4, br * 0.08, x, y, br);
      bg2.addColorStop(0, 'rgba(255,255,255,.55)'); bg2.addColorStop(0.35, 'rgba(255,255,255,.08)'); bg2.addColorStop(1, 'rgba(0,25,12,.4)');
      c.save(); c.beginPath(); c.arc(x, y, br, 0, 7); c.clip(); c.fillStyle = bg2; c.fillRect(x - br, y - br, br * 2, br * 2); c.restore();
      c.fillStyle = 'rgba(255,255,255,.9)'; c.beginPath(); c.arc(x - br * 0.32, y - br * 0.38, br * 0.09, 0, 7); c.fill();
      c.beginPath(); c.arc(x, y, br, 0, 7); c.strokeStyle = shade(col, 45) + '55'; c.lineWidth = 1.6; c.stroke();
      if (i < n - 1) { /* 穿珠绳 */
        const a2 = Math.PI * (0.15 + (0.7 * (i + 1)) / (n - 1));
        const x2 = cx + Math.cos(a2 + Math.PI) * arcR, y2 = cy + Math.sin(a2) * arcR * 0.5 + cy * 0.12;
        c.strokeStyle = 'rgba(190,160,110,.8)'; c.lineWidth = 2.2;
        c.beginPath();
        c.moveTo(x + Math.cos(a2) * br * 0.8, y + Math.sin(a2) * br * 0.8);
        c.lineTo(x2 - Math.cos(a2) * br * 0.8, y2 - Math.sin(a2) * br * 0.8);
        c.stroke();
      }
    }
  } else { /* scrap 碎石边角 */
    for (let i = 0; i < 5; i++) {
      const cx = W * (0.24 + rng() * 0.52), cy = W * (0.3 + rng() * 0.42), r = W * (0.05 + rng() * 0.06);
      shadow(cx, cy + r * 0.9, r * 1.1, r * 0.25);
      const chip = (ctx: CanvasRenderingContext2D) => {
        for (let k = 0; k <= 7; k++) {
          const a = (k / 7) * 7, rr = r * (0.75 + rng() * 0.5);
          const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * 0.8;
          if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
        ctx.closePath();
      };
      paintJade(chip);
      c.beginPath();
      for (let k = 0; k <= 7; k++) {
        const a = (k / 7) * 7, rr = r * (0.75 + rng() * 0.5);
        const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * 0.8;
        if (k) c.lineTo(x, y); else c.moveTo(x, y);
      }
      c.closePath();
      c.strokeStyle = shade(col, 42) + '66'; c.lineWidth = 1.6; c.stroke();
    }
  }
  return cv;
}

/** 缅川公盘成品视觉参数（游戏侧 ITEM_HARVEST itemData.params 携带） */
export interface GushiCraftData {
  kind: 'gushi';
  craft: string;   // bracelet | plaque | pingan | jiemian | beads | scrap
  gem: string;     // dou | nuo | bing | boli | diwang
  seed: number;
  size?: number;
}

/** 从 itemData（或其 params）提取缅川公盘成品视觉参数；非 gushi 数据返回 null */
export function extractGushiCraft(itemData: unknown): GushiCraftData | null {
  if (!itemData || typeof itemData !== 'object') return null;
  const src = itemData as Record<string, any>;
  const p = (src.params && typeof src.params === 'object' ? src.params : src) as Record<string, any>;
  const craft = p.craft;
  const gem = p.gem;
  const seed = parseInt(p.seed, 10);
  if (typeof craft !== 'string' || !craft.trim()) return null;
  if (typeof gem !== 'string' || !gemOf(gem)) return null;
  if (!Number.isFinite(seed)) return null;
  const sizeNum = Number(p.size);
  return {
    kind: 'gushi',
    craft,
    gem,
    seed,
    size: Number.isFinite(sizeNum) && sizeNum > 0 ? sizeNum : 1,
  };
}

interface GushiProductArtProps {
  craft: string;
  gem: string;
  seed: number;
  size?: number;
  className?: string;
  name?: string;
}

/** 成品图 canvas：与游戏内成品卡视觉一致（同 seed 同图） */
export function GushiProductArt({ craft, gem, seed, size, className = '', name }: GushiProductArtProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const drawn = drawGushiProduct(craft, gem, seed, size, 480);
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    cv.width = drawn.width;
    cv.height = drawn.height;
    ctx.drawImage(drawn, 0, 0);
  }, [craft, gem, seed, size]);
  return <canvas ref={ref} className={className} aria-label={name || '成品图'} />;
}

export default GushiProductArt;
