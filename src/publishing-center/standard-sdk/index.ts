/**
 * @allinone/standard-sdk
 * 
 * AllinONE 标准游戏 SDK
 * 为遵循AllinONE标准的游戏提供统一的平台接口
 */

import {
  AuthAPI,
  WalletAPI,
  InventoryAPI,
  StoreAPI,
  LeaderboardAPI,
  AchievementAPI,
  CloudSaveAPI,
  AnalyticsAPI,
} from './apis';
import { ProtocolClient, type ProtocolClientConfig } from './protocol/ProtocolClient';

// ==================== SDK配置 ====================

export interface AllinONEConfig {
  /** 游戏ID */
  gameId: string;
  /** 游戏名称 */
  gameName?: string;
  /** 应用ID */
  appId?: string;
  /** 环境 */
  environment?: 'development' | 'production';
  /** 调试模式 */
  debug?: boolean;
  /** 自动初始化 */
  autoInit?: boolean;
  /** Skills配置 */
  skills?: {
    auth?: boolean;
    wallet?: boolean;
    inventory?: boolean;
    store?: boolean;
    leaderboard?: boolean;
    achievements?: boolean;
    cloudSave?: boolean;
    analytics?: boolean;
  };
  /** 兑换道具清单（提供后将自动注入兑换条） */
  redeemItems?: RedeemItemConfig[];
}

// ==================== 兑换道具与效果注册表类型 ====================

export interface RedeemItemConfig {
  itemId: string;
  effectType: string;
  name: string;
  quantity?: number;
  effects?: Record<string, any>;
  rarity?: string;
}

/** 效果处理器 — 兑换码验证通过后由 SDK 内部调用 */
export type EffectHandler = (itemData: {
  itemId: string;
  effectType: string;
  quantity: number;
  effects: Record<string, any>;
}) => void;

// ==================== 游戏状态 ====================

export enum GameState {
  LOADING = 'loading',
  INITIALIZING = 'initializing',
  READY = 'ready',
  PLAYING = 'playing',
  PAUSED = 'paused',
  SAVING = 'saving',
  ERROR = 'error',
}

// ==================== 事件类型 ====================

export type GameEventType = 
  | 'init'
  | 'ready'
  | 'start'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'save'
  | 'load'
  | 'error'
  | 'skill:ready'
  | 'user:login'
  | 'user:logout'
  | 'wallet:update'
  | 'inventory:update';

export interface GameEvent {
  type: GameEventType;
  data?: any;
  timestamp: number;
}

export type GameEventHandler = (event: GameEvent) => void | Promise<void>;

// ==================== AllinONEGame 主类 ====================

export class AllinONEGame {
  // 配置
  private config: AllinONEConfig;
  
  // 状态
  private state: GameState = GameState.LOADING;
  private initialized: boolean = false;
  
  // API实例
  public auth: AuthAPI;
  public wallet: WalletAPI;
  public inventory: InventoryAPI;
  public store: StoreAPI;
  public leaderboard?: LeaderboardAPI;
  public achievements?: AchievementAPI;
  public cloudSave?: CloudSaveAPI;
  public analytics?: AnalyticsAPI;
  
  // 事件系统
  private eventHandlers: Map<GameEventType, Set<GameEventHandler>> = new Map();
  
  // 数据存储
  private sessionData: Map<string, any> = new Map();
  private persistentData: Map<string, any> = new Map();

  // 协议客户端
  public protocol?: ProtocolClient;

  // ==================== 效果注册表（兑换门控） ====================
  private effectRegistry: Map<string, EffectHandler> = new Map();
  private redeemItems: RedeemItemConfig[] = [];
  private redeemBarInjected: boolean = false;

  constructor(config: AllinONEConfig) {
    this.config = {
      environment: 'production',
      debug: false,
      autoInit: true,
      skills: {
        auth: true,
        wallet: true,
        inventory: true,
        store: true,
      },
      ...config,
    };

    // 初始化API
    this.auth = new AuthAPI(this);
    this.wallet = new WalletAPI(this);
    this.inventory = new InventoryAPI(this);
    this.store = new StoreAPI(this);

    // 可选Skills
    if (this.config.skills?.leaderboard) {
      this.leaderboard = new LeaderboardAPI(this);
    }
    if (this.config.skills?.achievements) {
      this.achievements = new AchievementAPI(this);
    }
    if (this.config.skills?.cloudSave) {
      this.cloudSave = new CloudSaveAPI(this);
    }
    if (this.config.skills?.analytics) {
      this.analytics = new AnalyticsAPI(this);
    }

    // 自动初始化
    if (this.config.autoInit) {
      this.initialize();
    }

    // ===== 效果注册表初始化 =====
    this.redeemItems = config.redeemItems || [];

    // ===== 始终注册 REDEEM_RESULT 监听（即使兑换条由 Protocol Bridge 注入） =====
    this.setupRedeemResultListener();

    if (this.redeemItems.length > 0) {
      // 在 DOM 就绪后注入兑换条（如果 Protocol Bridge 尚未注入）
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => this.injectRedeemBar());
      } else {
        this.injectRedeemBar();
      }
    }
  }

  // ==================== 生命周期方法 ====================

  /**
   * 初始化游戏
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.setState(GameState.INITIALIZING);
    this.log('Initializing AllinONE Game SDK...');

    try {
      // 初始化平台连接
      await this.initPlatform();

      // 按顺序初始化Skills
      if (this.config.skills?.auth) {
        await this.auth.initialize();
        this.emit('skill:ready', { skill: 'auth' });
      }

      if (this.config.skills?.wallet) {
        await this.wallet.initialize();
        this.emit('skill:ready', { skill: 'wallet' });
      }

      if (this.config.skills?.inventory) {
        await this.inventory.initialize();
        this.emit('skill:ready', { skill: 'inventory' });
      }

      if (this.config.skills?.store) {
        await this.store.initialize();
        this.emit('skill:ready', { skill: 'store' });
      }

      if (this.leaderboard) {
        await this.leaderboard.initialize();
        this.emit('skill:ready', { skill: 'leaderboard' });
      }

      if (this.achievements) {
        await this.achievements.initialize();
        this.emit('skill:ready', { skill: 'achievements' });
      }

      if (this.cloudSave) {
        await this.cloudSave.initialize();
        this.emit('skill:ready', { skill: 'cloudSave' });
      }

      if (this.analytics) {
        await this.analytics.initialize();
        this.emit('skill:ready', { skill: 'analytics' });
      }

      // 初始化协议客户端 (Mode B 自动握手)
      this.protocol = new ProtocolClient({
        gameId: this.config.gameId,
        mode: 'integrated',
        supportedSchemas: Object.entries(this.config.skills || {})
          .filter(([_, enabled]) => enabled)
          .map(([name]) => name),
        debug: this.config.debug,
      });
      await this.protocol.initialize();

      this.initialized = true;
      this.setState(GameState.READY);
      this.emit('init');
      this.emit('ready');

      this.log('AllinONE Game SDK initialized successfully');
    } catch (error) {
      this.setState(GameState.ERROR);
      this.emit('error', { error });
      throw error;
    }
  }

  /**
   * 开始游戏
   */
  async start(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    this.setState(GameState.PLAYING);
    this.emit('start');
    
    // 开始会话跟踪
    this.sessionData.set('sessionStart', Date.now());
    
    this.log('Game started');
  }

  /**
   * 暂停游戏
   */
  async pause(): Promise<void> {
    if (this.state === GameState.PLAYING) {
      this.setState(GameState.PAUSED);
      this.emit('pause');
      
      // 自动保存
      await this.save();
      
      this.log('Game paused');
    }
  }

  /**
   * 恢复游戏
   */
  async resume(): Promise<void> {
    if (this.state === GameState.PAUSED) {
      this.setState(GameState.PLAYING);
      this.emit('resume');
      this.log('Game resumed');
    }
  }

  /**
   * 停止游戏
   */
  async stop(): Promise<void> {
    this.setState(GameState.SAVING);
    
    // 保存数据
    await this.save();
    
    this.setState(GameState.LOADING);
    this.emit('stop');
    
    // 上报分析数据
    if (this.analytics) {
      const sessionDuration = Date.now() - (this.sessionData.get('sessionStart') || Date.now());
      await this.analytics.track('session_end', { duration: sessionDuration });
    }
    
    this.log('Game stopped');
  }

  /**
   * 保存游戏进度
   */
  async save(slot?: number): Promise<void> {
    this.setState(GameState.SAVING);
    this.emit('save', { slot });

    try {
      // 本地保存
      const saveData = this.collectSaveData();
      
      // 云存档
      if (this.cloudSave) {
        await this.cloudSave.save(saveData, slot);
      }

      // 持久化到本地存储
      localStorage.setItem(`allinone_save_${this.config.gameId}`, JSON.stringify(saveData));

      this.log(`Game saved${slot ? ` to slot ${slot}` : ''}`);
    } finally {
      if (this.state === GameState.SAVING) {
        this.setState(GameState.PLAYING);
      }
    }
  }

  /**
   * 加载游戏进度
   */
  async load(slot?: number): Promise<any> {
    this.emit('load', { slot });

    let saveData: any = null;

    // 优先从云存档加载
    if (this.cloudSave) {
      saveData = await this.cloudSave.load(slot);
    }

    // 回退到本地存储
    if (!saveData) {
      const localData = localStorage.getItem(`allinone_save_${this.config.gameId}`);
      if (localData) {
        saveData = JSON.parse(localData);
      }
    }

    if (saveData) {
      this.applySaveData(saveData);
      this.log(`Game loaded${slot ? ` from slot ${slot}` : ''}`);
    }

    return saveData;
  }

  // ==================== 事件系统 ====================

  /**
   * 监听事件
   */
  on(event: GameEventType, handler: GameEventHandler): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  /**
   * 取消监听
   */
  off(event: GameEventType, handler: GameEventHandler): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  /**
   * 触发事件
   */
  emit(event: GameEventType, data?: any): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      const eventObj: GameEvent = {
        type: event,
        data,
        timestamp: Date.now(),
      };
      
      handlers.forEach(handler => {
        try {
          handler(eventObj);
        } catch (error) {
          this.error('Event handler error:', error);
        }
      });
    }
  }

  // ==================== 数据管理 ====================

  /**
   * 设置会话数据
   */
  setSessionData(key: string, value: any): void {
    this.sessionData.set(key, value);
  }

  /**
   * 获取会话数据
   */
  getSessionData(key: string): any {
    return this.sessionData.get(key);
  }

  /**
   * 设置持久数据
   */
  setData(key: string, value: any): void {
    this.persistentData.set(key, value);
  }

  /**
   * 获取持久数据
   */
  getData(key: string): any {
    return this.persistentData.get(key);
  }

  // ==================== 辅助方法 ====================

  private async initPlatform(): Promise<void> {
    // 初始化与AllinONE平台的连接
    this.log('Connecting to AllinONE platform...');
    // 实际实现中这里会建立与平台的连接
    await this.delay(100);
  }

  private setState(state: GameState): void {
    this.state = state;
    this.log('State changed:', state);
  }

  private collectSaveData(): any {
    return {
      timestamp: Date.now(),
      sessionData: Object.fromEntries(this.sessionData),
      persistentData: Object.fromEntries(this.persistentData),
      gameState: this.state,
    };
  }

  private applySaveData(data: any): void {
    if (data.sessionData) {
      this.sessionData = new Map(Object.entries(data.sessionData));
    }
    if (data.persistentData) {
      this.persistentData = new Map(Object.entries(data.persistentData));
    }
  }

  // ==================== 效果注册表（兑换门控） ====================

  /**
   * 注册效果处理器 — 兑换码验证通过后由 SDK 内部自动调用
   * 游戏开发者调用此方法注册效果，避免 applyEffect() 被直接调用绕过兑换
   */
  registerEffect(effectType: string, handler: EffectHandler): void {
    this.effectRegistry.set(effectType, handler);
    this.log(`效果已注册: ${effectType} (需兑换码激活)`);
  }

  /** 兑换成功后由 SDK 内部调用（私有不对外开放） */
  private applyRegisteredEffect(itemData: {
    itemId: string;
    effectType: string;
    quantity: number;
    effects: Record<string, any>;
  }): boolean {
    const handler = this.effectRegistry.get(itemData.effectType);
    if (handler) {
      try {
        handler(itemData);
        this.log(`效果已执行: ${itemData.effectType} (通过兑换码激活)`);
        return true;
      } catch (e) {
        this.error('效果执行失败:', e);
      }
    } else {
      this.log(`未找到效果处理器: ${itemData.effectType}`);
    }
    return false;
  }

  /**
   * 注册 REDEEM_RESULT 全局监听器 — 无论兑换条由谁注入（SDK 或 Protocol Bridge），
   * 此监听器始终激活，确保 applyRegisteredEffect 被正确调用
   */
  private setupRedeemResultListener(): void {
    const self = this;
    window.addEventListener('message', function(event) {
      if (!event.data || event.data.type !== 'REDEEM_RESULT') return;
      const res = event.data.data;
      if (!res || !res.success) return;

      // 调用已注册的效果处理器
      self.applyRegisteredEffect({
        itemId: res.itemId || '',
        effectType: res.effectType || 'custom',
        quantity: res.quantity || 1,
        effects: res.effects || {},
      });

      // 分发 CustomEvent（向后兼容）
      const detail = {
        code: res.code,
        itemId: res.itemId || '',
        itemName: res.itemName || '',
        quantity: res.quantity || 1,
        effects: res.effects || {},
        effectType: res.effectType || 'custom',
      };
      // ⚠️ 只分发一种格式（allinone:item-redeemed），避免监听两种格式的游戏收到2个道具
      window.dispatchEvent(new CustomEvent('allinone:item-redeemed', { detail }));
    });
  }

  /**
   * 注入兑换条 UI — 提供输入框、兑换按钮和状态显示
   * 只有通过此兑换条验证的兑换码才能激活已注册的效果
   */
  private injectRedeemBar(): void {
    if (this.redeemBarInjected || document.getElementById('allinone-redeem-bar')) return;
    this.redeemBarInjected = true;

    // ===== 样式 =====
    const styles = document.createElement('style');
    styles.textContent = [
      '#allinone-redeem-bar{position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:99999;display:none;background:rgba(15,15,25,0.92);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:14px 22px;min-width:380px;max-width:500px;box-shadow:0 12px 48px rgba(0,0,0,0.5);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#fff;transition:all .3s ease;}',
      '#allinone-redeem-bar.show{display:block;}',
      '#allinone-redeem-bar .bar-row{display:flex;align-items:center;gap:10px;}',
      '#allinone-redeem-bar .bar-row input{flex:1;padding:10px 14px;border-radius:10px;border:1px solid rgba(139,92,246,0.3);background:rgba(255,255,255,0.06);color:#fff;font-size:14px;font-family:monospace;letter-spacing:2px;outline:none;transition:border-color .2s;}',
      '#allinone-redeem-bar .bar-row input:focus{border-color:rgba(139,92,246,0.7);}',
      '#allinone-redeem-bar .bar-row input::placeholder{font-family:sans-serif;letter-spacing:0;color:rgba(255,255,255,0.3);}',
      '#allinone-redeem-bar .bar-row .btn-redeem{padding:10px 22px;border-radius:10px;border:none;background:linear-gradient(135deg,#7c3aed,#6366f1);color:#fff;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .2s,transform .1s;white-space:nowrap;}',
      '#allinone-redeem-bar .bar-row .btn-redeem:hover{opacity:0.9;}',
      '#allinone-redeem-bar .bar-row .btn-redeem:active{transform:scale(0.97);}',
      '#allinone-redeem-bar .bar-row .btn-redeem:disabled{opacity:0.5;cursor:not-allowed;}',
      '#allinone-redeem-bar .bar-row .btn-close{padding:6px 10px;border-radius:8px;border:none;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.5);font-size:14px;cursor:pointer;transition:background .2s;}',
      '#allinone-redeem-bar .bar-row .btn-close:hover{background:rgba(255,255,255,0.15);color:#fff;}',
      '#allinone-redeem-bar .bar-status{margin-top:10px;font-size:12px;text-align:center;display:none;}',
      '#allinone-redeem-bar .bar-status.show{display:block;}',
      '#allinone-redeem-bar .bar-status.success{color:#4ade80;}',
      '#allinone-redeem-bar .bar-status.error{color:#f87171;}',
      '#allinone-redeem-bar .bar-status.loading{color:#a78bfa;}',
      '#allinone-redeem-bar .bar-status.info{color:#fbbf24;}',
      '#allinone-redeem-bar .bar-items{margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;}',
      '#allinone-redeem-bar .bar-items .item-chip{padding:4px 10px;border-radius:6px;background:rgba(139,92,246,0.1);border:1px solid rgba(139,92,246,0.15);font-size:11px;color:#a78bfa;cursor:default;user-select:none;}',
      '#allinone-redeem-bar .bar-hint{font-size:12px;color:rgba(255,255,255,0.45);margin-bottom:10px;text-align:center;line-height:1.4;}',
      '#allinone-redeem-bar .bar-items-label{font-size:11px;color:rgba(255,255,255,0.35);margin-top:10px;margin-bottom:4px;text-align:left;}',
      '#allinone-redeem-toggle{position:fixed;bottom:24px;right:24px;z-index:99998;width:48px;height:48px;border-radius:50%;border:2px solid rgba(124,58,237,0.4);background:rgba(15,15,25,0.85);backdrop-filter:blur(8px);color:#fff;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,0.4);transition:transform .2s,border-color .2s;}',
      '#allinone-redeem-toggle:hover{transform:scale(1.05);border-color:rgba(124,58,237,0.7);}',
      '#allinone-redeem-toggle .badge{position:absolute;top:-4px;right:-4px;width:16px;height:16px;border-radius:50%;background:#7c3aed;font-size:9px;display:flex;align-items:center;justify-content:center;color:#fff;display:none;}',
      '@keyframes allinone-pulse{0%{opacity:1;}50%{opacity:0.4;}100%{opacity:1;}}',
      '#allinone-redeem-bar.loading .btn-redeem{animation:allinone-pulse 1.2s ease-in-out infinite;}'
    ].join('');
    document.head.appendChild(styles);

    // ===== DOM 结构 =====
    const bar = document.createElement('div');
    bar.id = 'allinone-redeem-bar';
    bar.innerHTML = [
      '<div class="bar-hint">🎮 输入道具兑换码，点击「兑换」激活效果</div>',
      '<div class="bar-row">',
        '<input id="allinone-code-input" type="text" placeholder="粘贴或输入兑换码" maxlength="20" spellcheck="false" autocomplete="off">',
        '<button class="btn-redeem" id="allinone-redeem-btn">兑换</button>',
        '<button class="btn-close" id="allinone-bar-close">&times;</button>',
      '</div>',
      '<div class="bar-status" id="allinone-bar-status"></div>',
      this.redeemItems.length > 0 ? [
        '<div class="bar-items-label">本游戏可用道具：</div>',
        '<div class="bar-items">',
          this.redeemItems.map(function(item) {
            return '<span class="item-chip" title="' + item.name + '">' + item.name + '</span>';
          }).join(''),
        '</div>'
      ].join('') : ''
    ].join('');
    document.body.appendChild(bar);

    const toggle = document.createElement('button');
    toggle.id = 'allinone-redeem-toggle';
    toggle.innerHTML = '<span>🎁</span><span class="badge" id="allinone-badge"></span>';
    toggle.title = '兑换道具';
    document.body.appendChild(toggle);

    // ===== 元素引用 =====
    const input = document.getElementById('allinone-code-input') as HTMLInputElement;
    const btn = document.getElementById('allinone-redeem-btn') as HTMLButtonElement;
    const close = document.getElementById('allinone-bar-close') as HTMLButtonElement;
    const status = document.getElementById('allinone-bar-status') as HTMLElement;

    // ===== 事件绑定 =====
    toggle.onclick = function() {
      bar.classList.toggle('show');
      if (bar.classList.contains('show')) input.focus();
    };
    close.onclick = function() { bar.classList.remove('show'); };
    btn.onclick = function() { doRedeem(); };
    input.onkeydown = function(e) { if (e.key === 'Enter') doRedeem(); };

    const self = this;
    function showStatus(msg: string, type: string) {
      status.textContent = msg;
      status.className = 'bar-status show ' + type;
      bar.classList.remove('loading');
      if (type === 'success') {
        setTimeout(function() { status.classList.remove('show'); }, 4000);
      } else if (type !== 'loading') {
        setTimeout(function() { status.classList.remove('show'); }, 3000);
      }
    }

    function doRedeem() {
      const code = input.value.trim();
      if (!code) { showStatus('请输入兑换码', 'error'); return; }
      btn.disabled = true;
      btn.textContent = '验证中...';
      bar.classList.add('loading');
      showStatus('正在验证兑换码...', 'loading');

      window.parent.postMessage({
        type: 'REDEEM_ITEM',
        data: { code: code.toUpperCase(), gameId: self.config.gameId }
      }, '*');
    }

    // ===== 监听 REDEEM_RESULT → 仅更新 UI（效果调用已由 setupRedeemResultListener 处理） =====
    window.addEventListener('message', function(event) {
      if (event.data && event.data.type === 'REDEEM_RESULT') {
        const res = event.data.data;
        btn.disabled = false;
        btn.textContent = '兑换';
        bar.classList.remove('loading');

        if (res.success) {
          showStatus('&#10003; 兑换成功! ' + (res.itemName || '') + ' x' + (res.quantity || 1), 'success');
          input.value = '';
          setTimeout(function() { bar.classList.remove('show'); }, 1500);
        } else {
          showStatus('&#10007; ' + (res.message || '兑换失败'), 'error');
        }
      }
    });

    this.log('兑换条已注入, 道具: ' + this.redeemItems.length + ' 种 (需兑换码激活)');
  }

  private log(...args: any[]): void {
    if (this.config.debug) {
      console.log('[AllinONE]', ...args);
    }
  }

  private error(...args: any[]): void {
    console.error('[AllinONE]', ...args);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ==================== 便捷方法 ====================

  /**
   * 获取当前状态
   */
  getState(): GameState {
    return this.state;
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 获取配置
   */
  getConfig(): AllinONEConfig {
    return { ...this.config };
  }

  /**
   * 奖励玩家
   */
  async giveReward(computingPower: number, gameCoins: number, options?: { reason?: string }): Promise<void> {
    if (this.wallet) {
      await this.wallet.reward({
        computingPower,
        gameCoins,
        reason: options?.reason,
      });
    }
  }

  /**
   * 显示商店
   */
  async showStore(): Promise<void> {
    if (this.store) {
      await this.store.open();
    }
  }

  /**
   * 提交分数到排行榜
   */
  async submitScore(score: number, metadata?: Record<string, any>): Promise<void> {
    if (this.leaderboard) {
      await this.leaderboard.submitScore(score, metadata);
    }
  }

  /**
   * 解锁成就
   */
  async unlockAchievement(achievementId: string): Promise<void> {
    if (this.achievements) {
      await this.achievements.unlock(achievementId);
    }
  }
}

// ==================== 导出 ====================

export * from './apis';
export * from './types';

// 协议客户端
export { ProtocolClient } from './protocol/ProtocolClient';
export type { ProtocolClientConfig } from './protocol/ProtocolClient';

export default AllinONEGame;
