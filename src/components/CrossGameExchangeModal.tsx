/**
 * CrossGameExchangeModal — 跨游戏道具兑换方式选择弹窗
 *
 * 起因：不同游戏的 effect 是各自私有的实现，A 游戏的道具直接搬进 B 游戏
 * 必然报「未找到效果」。因此玩家跨游戏使用时，必须先选定一条明确的转换路径：
 *
 *   A 等值兑换（推荐）— 兑换为目标游戏自己的道具凭证，100% 生效
 *   B 语义映射        — 效果替换为语义等价的目标 effect
 *   C 原样搬运（高风险，默认折叠）
 *
 * 由于会核销源凭证，非推荐路径需玩家显式勾选确认。
 */

import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowLeftRight, X, Loader2, ShieldCheck, AlertTriangle,
  CheckCircle2, Package, Sparkles, Coins, Wallet, CircleDollarSign,
} from 'lucide-react';
import {
  listConversionOptions,
  executeConversion,
  clearConversionCache,
  calcExchangeFee,
  type ConversionOption,
  type ConversionListResult,
} from '@/services/crossGameExchange';
import { TAG_LABELS } from '@/publishing-center/protocol/EffectTags';
import { skillGateway } from '@/skills';
import { VoucherStatus, type Voucher } from '@/voucher-system/types';
import { voucherService } from '@/voucher-system';

interface Props {
  voucher: Voucher;
  targetGameId: string;
  targetGameName?: string;
  userId: string;
  userName: string;
  onClose: () => void;
  /** 兑换成功回调（路径 A 会带上目标游戏的新凭证 ID） */
  onConverted: (payload: { newVoucherId?: string; dispatchedToGame?: boolean }) => void;
}

const MODE_META: Record<
  ConversionOption['mode'],
  { title: string; icon: React.ReactNode; accent: string; badge: string }
> = {
  EQUIVALENT: {
    title: '等值兑换',
    icon: <ShieldCheck className="w-4 h-4" />,
    accent: 'border-emerald-500/60 bg-emerald-500/10',
    badge: '推荐 · 100% 生效',
  },
  SEMANTIC: {
    title: '语义映射',
    icon: <Sparkles className="w-4 h-4" />,
    accent: 'border-cyan-500/60 bg-cyan-500/10',
    badge: '效果等价替换',
  },
  RAW: {
    title: '原样搬运',
    icon: <AlertTriangle className="w-4 h-4" />,
    accent: 'border-amber-500/60 bg-amber-500/10',
    badge: '高风险 · 可能无效',
  },
};

export default function CrossGameExchangeModal({
  voucher,
  targetGameId,
  targetGameName,
  userId,
  userName,
  onClose,
  onConverted,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [list, setList] = useState<ConversionListResult | null>(null);
  const [selectedId, setSelectedId] = useState<string>('');
  const [showRisky, setShowRisky] = useState(false);
  const [ackRisk, setAckRisk] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ message: string; newVoucherId?: string } | null>(null);

  // ---- 支付（手续费 + 差价补齐）----
  const [paymentMethod, setPaymentMethod] = useState<'gamecoin' | 'voucher'>('gamecoin');
  const [gameCoins, setGameCoins] = useState<number | null>(null);
  const [payableVouchers, setPayableVouchers] = useState<Voucher[]>([]);
  const [walletLoading, setWalletLoading] = useState(true);

  // 加载玩家钱包游戏币余额与可支付（有面额）的A币凭证
  useEffect(() => {
    let cancelled = false;
    setWalletLoading(true);
    (async () => {
      try {
        const bal = await skillGateway.execute('wallet', 'getBalance', {}, { userId, sessionId: 'web' });
        if (cancelled) return;
        setGameCoins(bal.success && bal.data ? Number((bal.data as any).gameCoins || 0) : 0);
      } catch {
        if (!cancelled) setGameCoins(0);
      }
      try {
        const list = voucherService.getUserVouchers(userId).filter(
          v => v.status === VoucherStatus.ACTIVE && Number((v as any).denomination || 0) > 0
        );
        if (!cancelled) setPayableVouchers(list);
      } catch {
        if (!cancelled) setPayableVouchers([]);
      }
      if (!cancelled) setWalletLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    try {
      const result = listConversionOptions({ voucherId: voucher.id, targetGameId, userId });
      if (cancelled) return;
      setList(result);
      if (result.recommendedId) setSelectedId(result.recommendedId);
      if (!result.ok) setError(result.message || '无法读取该道具的兑换方案');
    } catch (e) {
      if (!cancelled) setError(e instanceof Error ? e.message : '读取兑换方案失败');
    } finally {
      if (!cancelled) setLoading(false);
    }
    return () => {
      cancelled = true;
    };
  }, [voucher.id, targetGameId, userId]);

  useEffect(() => {
    setAckRisk(false);
  }, [selectedId]);

  const options = list?.options || [];
  const safeOptions = useMemo(() => options.filter(o => o.mode !== 'RAW'), [options]);
  const riskyOptions = useMemo(() => options.filter(o => o.mode === 'RAW'), [options]);
  const selected = options.find(o => o.optionId === selectedId);

  // ---- 应付计算：手续费（目标道具价值 × 10%）+ 差价补齐 ----
  const fee = selected ? calcExchangeFee(selected.targetValue) : 0;
  const topUp = selected?.topUpAmount || 0;
  const totalPay = Number((topUp + fee).toFixed(2));

  // A币凭证自动凑整（面额升序贪心，整张支付不找零）
  const pickedPayVouchers = useMemo(() => {
    if (paymentMethod !== 'voucher' || totalPay <= 0) return [];
    const sorted = [...payableVouchers].sort(
      (a, b) => Number((a as any).denomination || 0) - Number((b as any).denomination || 0)
    );
    const picked: Voucher[] = [];
    let sum = 0;
    for (const v of sorted) {
      picked.push(v);
      sum += Number((v as any).denomination || 0);
      if (sum >= totalPay) break;
    }
    return sum >= totalPay ? picked : [];
  }, [paymentMethod, totalPay, payableVouchers]);
  const pickedSum = pickedPayVouchers.reduce((s, v) => s + Number((v as any).denomination || 0), 0);

  const gameCoinEnough = gameCoins != null && gameCoins >= totalPay;
  const canPay =
    totalPay <= 0 ||
    (paymentMethod === 'gamecoin' ? gameCoinEnough : pickedPayVouchers.length > 0);

  const handleConfirm = async () => {
    if (!selected || executing) return;
    if (selected.mode === 'RAW' && !ackRisk) return;

    setExecuting(true);
    setError(null);
    try {
      const result = await executeConversion({
        voucherId: voucher.id,
        userId,
        userName,
        targetGameId,
        optionId: selected.optionId,
        paymentMethod: totalPay > 0 ? paymentMethod : undefined,
        paymentVoucherIds: totalPay > 0 && paymentMethod === 'voucher'
          ? pickedPayVouchers.map(v => v.id)
          : undefined,
      });
      if (!result.success) {
        setError(result.message);
        return;
      }
      setSuccess({ message: result.message, newVoucherId: result.newVoucherId });
      onConverted({ newVoucherId: result.newVoucherId, dispatchedToGame: result.dispatchedToGame });
    } catch (e) {
      setError(e instanceof Error ? e.message : '兑换失败');
    } finally {
      setExecuting(false);
    }
  };

  const handleClose = () => {
    clearConversionCache(voucher.id);
    onClose();
  };

  const renderOption = (option: ConversionOption) => {
    const meta = MODE_META[option.mode];
    const active = option.optionId === selectedId;
    return (
      <button
        key={option.optionId}
        type="button"
        onClick={() => setSelectedId(option.optionId)}
        className={`w-full text-left p-4 rounded-xl border transition-all ${
          active ? meta.accent : 'border-slate-700 bg-slate-800/50 hover:border-slate-600'
        }`}
      >
        <div className="flex items-start gap-3">
          <div className={`mt-0.5 ${active ? 'text-emerald-300' : 'text-slate-400'}`}>
            {meta.icon}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-white">{option.label}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700/70 text-slate-300">
                {meta.title}
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700/50 text-slate-400">
                {meta.badge}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">{option.detail}</p>

            <div className="flex items-center gap-3 mt-2 flex-wrap text-[11px]">
              <span className="text-slate-400">
                估值 {option.sourceValue} → <span className="text-white">{option.targetValue}</span> {option.currency}
              </span>
              {option.valueLoss > 0.2 && (
                <span className="text-amber-400">折损 {Math.round(option.valueLoss * 100)}%</span>
              )}
              <span className="text-slate-500">可靠度 {Math.round(option.confidence * 100)}%</span>
            </div>

            {option.notes && option.notes.length > 0 && (
              <ul className="mt-2 space-y-0.5">
                {option.notes.map((n, i) => (
                  <li key={i} className="text-[11px] text-slate-500">· {n}</li>
                ))}
              </ul>
            )}
          </div>
          <div
            className={`w-4 h-4 mt-1 rounded-full border shrink-0 ${
              active ? 'border-emerald-400 bg-emerald-400/30' : 'border-slate-600'
            }`}
          />
        </div>
      </button>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-2xl max-h-[88vh] flex flex-col bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-slate-700">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-indigo-500/20">
              <ArrowLeftRight className="w-5 h-5 text-indigo-300" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-white">跨游戏道具兑换</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                「{voucher.metadata?.name || '未知道具'}」来自其他游戏
                {targetGameName && <>，将转换为 {targetGameName} 的道具</>}
              </p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-12 text-slate-400">
              <Loader2 className="w-5 h-5 animate-spin" />
              正在计算可用的兑换方式…
            </div>
          )}

          {!loading && success && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 rounded-xl border border-emerald-500/40 bg-emerald-500/10">
                <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-white">兑换成功</p>
                  <p className="text-xs text-slate-300 mt-1">{success.message}</p>
                </div>
              </div>

              {!success.newVoucherId && (
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <Package className="w-4 h-4" />
                  道具已下发到正在运行的游戏
                </div>
              )}
            </div>
          )}

          {!loading && !success && error && (
            <div className="flex items-start gap-3 p-4 rounded-xl border border-red-500/40 bg-red-500/10">
              <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-white">无法兑换</p>
                <p className="text-xs text-slate-300 mt-1">{error}</p>
                {list && list.sourceTags.length > 0 && (
                  <p className="text-[11px] text-slate-500 mt-2">
                    识别到的语义：{list.sourceTags.map(t => TAG_LABELS[t] || t).join('、')}
                  </p>
                )}
              </div>
            </div>
          )}

          {!loading && !success && !error && options.length === 0 && list?.message && (
            <div className="flex items-start gap-3 p-4 rounded-xl border border-amber-500/40 bg-amber-500/10">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-white">暂无可用的兑换方式</p>
                <p className="text-xs text-slate-300 mt-1">{list.message}</p>
              </div>
            </div>
          )}

          {!loading && !success && !error && options.length > 0 && (
            <>
              {/* 估值摘要 */}
              {list && (
                <div className="flex items-center gap-3 p-3 rounded-xl bg-slate-800/60 border border-slate-700">
                  <Coins className="w-4 h-4 text-amber-400" />
                  <div className="text-xs text-slate-300">
                    源道具估值 <span className="text-white font-medium">{list.sourceValue}</span>
                    {list.sourceTags.length > 0 ? (
                      <span className="ml-2 text-slate-500">
                        语义：{list.sourceTags.map(t => TAG_LABELS[t] || t).join('、')}
                      </span>
                    ) : (
                      <span className="ml-2 text-slate-500">无通用语义（仅支持等值兑换）</span>
                    )}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                {safeOptions.map(renderOption)}
              </div>

              {riskyOptions.length > 0 && (
                <div className="pt-1">
                  <button
                    type="button"
                    onClick={() => setShowRisky(v => !v)}
                    className="text-xs text-slate-400 hover:text-slate-200 transition-colors"
                  >
                    {showRisky ? '收起高风险方式' : `显示高风险方式（${riskyOptions.length}）`}
                  </button>
                  {showRisky && <div className="mt-2 space-y-2">{riskyOptions.map(renderOption)}</div>}
                </div>
              )}

              {selected?.mode === 'RAW' && (
                <label className="flex items-start gap-2 p-3 rounded-xl border border-amber-500/40 bg-amber-500/10 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ackRisk}
                    onChange={e => setAckRisk(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span className="text-xs text-amber-200">
                    我了解「原样搬运」大概率会在游戏中报「未找到效果」，且兑换后原道具凭证将被核销。
                  </span>
                </label>
              )}

              {selected?.mode === 'EQUIVALENT' && (
                <p className="text-[11px] text-slate-500">
                  兑换后原道具凭证将被核销，你会获得本游戏的一张全新道具凭证。
                </p>
              )}

              {/* ---- 支付区域：手续费 + 差价补齐（2026-09-13） ---- */}
              {selected && !walletLoading && (
                <div className="p-4 rounded-xl border border-slate-700 bg-slate-800/60 space-y-3">
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <CircleDollarSign className="w-4 h-4 text-amber-400" />
                    <span className="font-medium text-slate-300">支付明细</span>
                  </div>
                  <div className="text-xs text-slate-300 space-y-1.5">
                    <div className="flex justify-between gap-4">
                      <span>兑换手续费（目标道具价值的 10%）</span>
                      <span className="text-white font-medium">{fee} A币</span>
                    </div>
                    {topUp > 0 && (
                      <div className="flex justify-between gap-4">
                        <span>差价补齐（目标道具价格 − 源估值）</span>
                        <span className="text-white font-medium">{topUp} A币</span>
                      </div>
                    )}
                    <div className="flex justify-between gap-4 pt-1.5 border-t border-slate-700">
                      <span className="font-semibold text-white">应付合计</span>
                      <span className="text-amber-300 font-bold">{totalPay} A币</span>
                    </div>
                  </div>

                  {totalPay > 0 ? (
                    <>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => setPaymentMethod('gamecoin')}
                          className={`p-2.5 rounded-lg border text-left transition-all ${
                            paymentMethod === 'gamecoin'
                              ? 'border-emerald-500/60 bg-emerald-500/10'
                              : 'border-slate-700 bg-slate-800/50 hover:border-slate-600'
                          }`}
                        >
                          <div className="flex items-center gap-1.5 text-xs font-medium text-white">
                            <Wallet className="w-3.5 h-3.5" />
                            钱包游戏币
                          </div>
                          <div className="text-[11px] text-slate-400 mt-0.5">
                            余额 {gameCoins ?? '…'}（精确扣款）
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={() => setPaymentMethod('voucher')}
                          className={`p-2.5 rounded-lg border text-left transition-all ${
                            paymentMethod === 'voucher'
                              ? 'border-emerald-500/60 bg-emerald-500/10'
                              : 'border-slate-700 bg-slate-800/50 hover:border-slate-600'
                          }`}
                        >
                          <div className="flex items-center gap-1.5 text-xs font-medium text-white">
                            <Coins className="w-3.5 h-3.5" />
                            A币凭证
                          </div>
                          <div className="text-[11px] text-slate-400 mt-0.5">
                            可用 {payableVouchers.length} 张（整张支付）
                          </div>
                        </button>
                      </div>

                      {paymentMethod === 'gamecoin' && gameCoins != null && gameCoins < totalPay && (
                        <p className="text-[11px] text-red-300">
                          游戏币余额不足（需要 {totalPay}，当前 {gameCoins}）
                        </p>
                      )}
                      {paymentMethod === 'voucher' && (
                        pickedPayVouchers.length > 0 ? (
                          <p className="text-[11px] text-emerald-300">
                            将消耗 {pickedPayVouchers.length} 张A币凭证（合计 {pickedSum}，整张支付不找零）：
                            {pickedPayVouchers.map(v => `${v.metadata?.name || 'A币'}×${Number((v as any).denomination)}`).join('、')}
                          </p>
                        ) : (
                          <p className="text-[11px] text-red-300">
                            没有足够的A币凭证支付 {totalPay}，请改用游戏币支付
                          </p>
                        )
                      )}
                    </>
                  ) : (
                    <p className="text-[11px] text-slate-500">本次兑换无需额外支付</p>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-700">
          <button
            onClick={handleClose}
            className="px-4 py-2 text-sm rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
          >
            {success ? '完成' : '取消'}
          </button>
          {!success && options.length > 0 && (
            <button
              onClick={handleConfirm}
              disabled={!selected || executing || (selected.mode === 'RAW' && !ackRisk) || !canPay}
              className="flex items-center gap-2 px-5 py-2 text-sm rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium transition-colors"
            >
              {executing && <Loader2 className="w-4 h-4 animate-spin" />}
              {executing ? '兑换中…' : totalPay > 0 ? `支付 ${totalPay} 并兑换` : '确认兑换'}
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );
}
