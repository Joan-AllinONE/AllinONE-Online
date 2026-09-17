/**
 * ItemDataArtwork — 道具凭证「作品图」通用渲染组件
 *
 * 背景：游戏内提取的道具凭证（ITEM_HARVEST）中，作品类 Schema（如 perler-artwork）
 * 的 itemData.params 采用「调色板 + 网格索引串」紧凑编码（防超 8KB 限制），
 * 平台 UI 无法直接显示图片。本组件在平台侧解码并用 canvas 重绘作品缩略图。
 *
 * 使用：
 *   <ItemDataArtwork voucher={v} name={v.metadata?.name} className="w-12 h-12 ..." />
 *   - 凭证含作品数据（metadata.customData.gameEffect.itemData.params）→ canvas 重绘
 *   - 否则 fallback：名称首字符（与原 UI 完全一致，不影响效果类道具）
 */
import { useEffect, useMemo, useRef } from 'react';

/** 作品数据（palette + base36 cells 紧凑编码，与游戏侧编码约定一致） */
export interface ArtworkData {
  w: number;
  h: number;
  palette: string[];
  cells: string;
}

/** 画布内部分辨率（CSS 尺寸由 className 控制，固定高内部分辨率防糊） */
const CANVAS_RES = 160;

/**
 * 从 itemData 提取作品数据；非法输入返回 null。
 * 兼容两种入参：完整 itemData（{effect, params:{w,h,palette,cells}}）或直接传 params。
 */
export function extractArtwork(itemData: unknown): ArtworkData | null {
  if (!itemData || typeof itemData !== 'object') return null;
  const p = (itemData as Record<string, any>).params || itemData;
  const w = parseInt(p.w, 10);
  const h = parseInt(p.h, 10);
  if (!(w > 0 && w <= 59 && h > 0 && h <= 59)) return null;
  if (!Array.isArray(p.palette) || p.palette.length === 0) return null;
  if (typeof p.cells !== 'string' || p.cells.length !== w * h) return null;
  return { w, h, palette: p.palette as string[], cells: p.cells };
}

/** 从凭证（Voucher）提取作品数据（metadata.customData.gameEffect.itemData） */
export function extractArtworkFromVoucher(voucher: unknown): ArtworkData | null {
  if (!voucher || typeof voucher !== 'object') return null;
  const v = voucher as Record<string, any>;
  const cd = v.metadata?.customData || v.customData || {};
  const ge = cd.gameEffect || {};
  return extractArtwork(ge.itemData);
}

/** 解码 cells → 二维 hex 网格（"." 为空格） */
export function decodeArtworkGrid(art: ArtworkData): (string | null)[][] {
  const g: (string | null)[][] = [];
  for (let r = 0; r < art.h; r++) {
    const row: (string | null)[] = [];
    for (let c = 0; c < art.w; c++) {
      const ch = art.cells.charAt(r * art.w + c);
      if (ch === '.' || ch === '') { row.push(null); continue; }
      const idx = parseInt(ch, 36);
      row.push(idx >= 0 && idx < art.palette.length ? (art.palette[idx] || null) : null);
    }
    g.push(row);
  }
  return g;
}

interface ItemDataArtworkProps {
  /** 凭证对象（自动读取 metadata.customData.gameEffect.itemData） */
  voucher?: unknown;
  /** 或直接传 itemData / params（palette+cells 形态） */
  itemData?: unknown;
  /** 无作品数据时 fallback 显示的名称（取首字符） */
  name?: string;
  /** 容器 className（canvas 与 fallback div 共用） */
  className?: string;
}

export function ItemDataArtwork({ voucher, itemData, name, className = '' }: ItemDataArtworkProps) {
  const art = useMemo(
    () => extractArtwork(itemData) || extractArtworkFromVoucher(voucher),
    [itemData, voucher],
  );
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!art) return;
    const cv = canvasRef.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    cv.width = CANVAS_RES;
    cv.height = CANVAS_RES;
    // 白底 + 圆点豆子（与拼豆游戏收藏缩略图风格一致）
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, CANVAS_RES, CANVAS_RES);
    const cs = Math.max(1, Math.floor(CANVAS_RES / Math.max(art.w, art.h)));
    const ox = Math.floor((CANVAS_RES - cs * art.w) / 2);
    const oy = Math.floor((CANVAS_RES - cs * art.h) / 2);
    for (let r = 0; r < art.h; r++) {
      for (let c = 0; c < art.w; c++) {
        const ch = art.cells.charAt(r * art.w + c);
        if (ch === '.') continue;
        const idx = parseInt(ch, 36);
        const hex = art.palette[idx];
        if (!hex) continue;
        ctx.beginPath();
        ctx.arc(ox + c * cs + cs / 2, oy + r * cs + cs / 2, cs * 0.45, 0, Math.PI * 2);
        ctx.fillStyle = hex;
        ctx.fill();
      }
    }
  }, [art]);

  if (!art) {
    return <div className={className}>{(name || '?').charAt(0) || '?'}</div>;
  }
  return <canvas ref={canvasRef} className={className} aria-label={name || '作品图'} />;
}

export default ItemDataArtwork;
