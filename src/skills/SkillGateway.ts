/**
 * AllinONE Skill 系统 - Skill 网关
 * 统一接入层：路由、认证、限流、日志、错误处理
 */

import {
  Skill,
  SkillContext,
  SkillRequest,
  SkillResponse,
  SkillGatewayInterface,
  EventHandler,
  SkillMiddleware,
  SkillGatewayConfig,
} from './types';
import { EventBus } from './EventBus';
import { SkillErrors, createError } from './errors';
import { SkillErrorCode } from './types';

/**
 * 限流器
 */
class RateLimiter {
  private requests: Map<string, number[]> = new Map();

  constructor(
    private windowMs: number = 60000,
    private maxRequests: number = 100
  ) {}

  checkLimit(key: string): { allowed: boolean; retryAfter?: number } {
    const now = Date.now();
    const timestamps = this.requests.get(key) || [];
    
    // 清理过期请求
    const validTimestamps = timestamps.filter(t => now - t < this.windowMs);
    
    if (validTimestamps.length >= this.maxRequests) {
      const oldestTimestamp = validTimestamps[0];
      const retryAfter = this.windowMs - (now - oldestTimestamp);
      return { allowed: false, retryAfter };
    }

    validTimestamps.push(now);
    this.requests.set(key, validTimestamps);
    return { allowed: true };
  }

  reset(key: string): void {
    this.requests.delete(key);
  }
}

/**
 * Skill 网关
 * 核心职责：
 * 1. Skill 注册与管理
 * 2. 请求路由
 * 3. 认证与鉴权
 * 4. 限流
 * 5. 中间件链
 * 6. 事件转发
 */
export class SkillGateway implements SkillGatewayInterface {
  private skills: Map<string, Skill> = new Map();
  private middlewares: SkillMiddleware[] = [];
  private eventBus: EventBus;
  private rateLimiter: RateLimiter;
  private config: Required<SkillGatewayConfig>;

  constructor(config: SkillGatewayConfig = {}) {
    this.config = {
      defaultTimeout: 30000,
      debug: false,
      authHandler: async (ctx) => ctx as SkillContext,
      permissionChecker: () => true,
      ...config,
    };
    this.eventBus = new EventBus();
    this.rateLimiter = new RateLimiter();
  }

  /**
   * 注册 Skill
   * @param skill Skill 实例
   * @param config Skill 配置
   */
  async registerSkill(skill: Skill, config?: any): Promise<void> {
    const { name } = skill.definition;

    if (this.skills.has(name)) {
      console.warn(`[SkillGateway] Skill ${name} 已存在，将被覆盖`);
    }

    // 检查依赖
    if (skill.definition.dependencies) {
      for (const dep of skill.definition.dependencies) {
        if (!this.skills.has(dep)) {
          throw new Error(`Skill ${name} 依赖 ${dep} 未注册`);
        }
      }
    }

    // 初始化 Skill
    await skill.initialize(this, config);
    this.skills.set(name, skill);

    this.log('info', `Skill 已注册: ${name} v${skill.definition.version}`);
  }

  /**
   * 注销 Skill
   * @param name Skill 名称
   */
  async unregisterSkill(name: string): Promise<void> {
    const skill = this.skills.get(name);
    if (skill && skill.destroy) {
      await skill.destroy();
    }
    this.skills.delete(name);
    this.log('info', `Skill 已注销: ${name}`);
  }

  /**
   * 获取 Skill 实例
   */
  getSkill<T extends Skill>(name: string): T | undefined {
    return this.skills.get(name) as T;
  }

  /**
   * 执行 Skill 动作
   * 核心方法，处理完整的请求生命周期
   */
  async execute<T = any>(
    skillName: string,
    action: string,
    params: any = {},
    context: Partial<SkillContext> = {}
  ): Promise<SkillResponse<T>> {
    const startTime = Date.now();
    const requestId = crypto.randomUUID();

    try {
      // 1. 构建完整上下文
      const fullContext = await this.buildContext(context);

      // 2. 检查限流
      const rateLimitKey = `${fullContext.userId}:${skillName}:${action}`;
      const rateLimit = this.rateLimiter.checkLimit(rateLimitKey);
      if (!rateLimit.allowed) {
        return this.createErrorResponse(
          requestId,
          SkillErrors.rateLimited(rateLimit.retryAfter),
          startTime
        );
      }

      // 3. 查找 Skill
      const skill = this.skills.get(skillName);
      if (!skill) {
        return this.createErrorResponse(
          requestId,
          SkillErrors.skillNotFound(skillName),
          startTime
        );
      }

      // 4. 构建请求对象
      const request: SkillRequest = {
        action,
        params,
        context: fullContext,
        requestId,
        timestamp: startTime,
      };

      // 5. 检查动作支持
      if (!skill.supportsAction(action)) {
        return this.createErrorResponse(
          requestId,
          SkillErrors.actionNotFound(skillName, action),
          startTime
        );
      }

      // 6. 获取动作定义并检查权限
      const actionDef = skill.getActionDefinition(action);
      if (actionDef) {
        for (const permission of actionDef.requiredPermissions) {
          if (!this.config.permissionChecker(fullContext, permission)) {
            return this.createErrorResponse(
              requestId,
              SkillErrors.forbidden(permission),
              startTime
            );
          }
        }
      }

      // 7. 执行中间件链
      const executeSkill = async (): Promise<SkillResponse<T>> => {
        const response = await skill.execute<T>(request);
        return {
          ...response,
          meta: {
            ...response.meta,
            executionTime: Date.now() - startTime,
          },
        };
      };

      const response = await this.runMiddlewares(request, executeSkill);
      
      // 8. 记录日志
      this.logRequest(skillName, action, request, response);

      return response;

    } catch (error) {
      this.log('error', `执行失败: ${skillName}.${action}`, { error, requestId });
      return this.createErrorResponse(
        requestId,
        createError(
          SkillErrorCode.UNKNOWN_ERROR,
          error instanceof Error ? error.message : '未知错误',
          error
        ),
        startTime
      );
    }
  }

  /**
   * 执行中间件链
   */
  private async runMiddlewares(
    request: SkillRequest,
    finalHandler: () => Promise<SkillResponse>
  ): Promise<SkillResponse> {
    let index = 0;

    const next = async (): Promise<SkillResponse> => {
      if (index < this.middlewares.length) {
        const middleware = this.middlewares[index++];
        return middleware(request, next);
      }
      return finalHandler();
    };

    return next();
  }

  /**
   * 构建完整上下文
   */
  private async buildContext(partial: Partial<SkillContext>): Promise<SkillContext> {
    const baseContext: SkillContext = {
      userId: partial.userId || 'anonymous',
      sessionId: partial.sessionId || crypto.randomUUID(),
      authToken: partial.authToken,
      permissions: partial.permissions || [],
      clientInfo: partial.clientInfo || {
        platform: 'unknown',
        version: '1.0.0',
      },
      source: partial.source || 'unknown',
      ...partial,
    };

    // 通过认证处理器增强上下文
    return await this.config.authHandler(baseContext);
  }

  /**
   * 创建错误响应
   */
  private createErrorResponse(
    requestId: string,
    error: ReturnType<typeof createError>,
    startTime: number
  ): SkillResponse {
    return {
      success: false,
      error,
      requestId,
      timestamp: Date.now(),
      meta: {
        executionTime: Date.now() - startTime,
      },
    };
  }

  /**
   * 添加中间件
   */
  use(middleware: SkillMiddleware): void {
    this.middlewares.push(middleware);
  }

  /**
   * 发布事件
   */
  emit(event: string, data: any, context?: SkillContext): void {
    const ctx = context || {
      userId: 'system',
      sessionId: 'system',
    };
    this.eventBus.emit(event, data, ctx);
  }

  /**
   * 订阅事件
   */
  on(event: string, handler: EventHandler): void {
    this.eventBus.on(event, handler);
  }

  /**
   * 取消订阅事件
   */
  off(event: string, handler: EventHandler): void {
    this.eventBus.off(event, handler);
  }

  /**
   * 获取已注册的 Skills 列表
   */
  getRegisteredSkills(): Array<{ name: string; version: string; description: string }> {
    return Array.from(this.skills.values()).map(skill => ({
      name: skill.definition.name,
      version: skill.definition.version,
      description: skill.definition.description,
    }));
  }

  /**
   * 获取 Skill 定义
   */
  getSkillDefinition(name: string) {
    return this.skills.get(name)?.definition;
  }

  /**
   * 销毁网关
   */
  async destroy(): Promise<void> {
    for (const [name, skill] of this.skills) {
      if (skill.destroy) {
        await skill.destroy();
      }
    }
    this.skills.clear();
    this.middlewares = [];
    this.eventBus.clear();
  }

  /**
   * 日志记录
   */
  private log(level: 'info' | 'warn' | 'error', message: string, meta?: any): void {
    if (!this.config.debug && level === 'info') return;
    
    const prefix = '[SkillGateway]';
    if (meta) {
      console[level](`${prefix} ${message}`, meta);
    } else {
      console[level](`${prefix} ${message}`);
    }
  }

  /**
   * 请求日志
   */
  private logRequest(
    skillName: string,
    action: string,
    request: SkillRequest,
    response: SkillResponse
  ): void {
    if (!this.config.debug) return;

    const duration = response.meta?.executionTime || 0;
    const status = response.success ? 'SUCCESS' : 'FAILED';
    
    console.log(
      `[SkillGateway] ${status} | ${skillName}.${action} | ${duration}ms | ${request.requestId}`
    );
  }
}

// ==================== 单例导出 ====================

/**
 * 获取默认网关实例（懒初始化）
 *
 * ⚠️ 不要从本文件导入 skillGateway 实例！
 * skillGateway 单例在 skills/index.ts 中首次创建（带 debug 等配置）并导出。
 * 所有需要 skillGateway 实例的代码应从 skills/index 导入：
 *   import { skillGateway } from '@/skills/index';
 *
 * 本文件仅导出 SkillGateway 类、getDefaultGateway 函数和 resetDefaultGateway 函数。
 */
export function getDefaultGateway(config?: SkillGatewayConfig): SkillGateway {
  if (!defaultGateway) {
    defaultGateway = new SkillGateway(config);
  }
  return defaultGateway;
}

let defaultGateway: SkillGateway | null = null;

/**
 * 重置默认网关（主要用于测试）
 */
export function resetDefaultGateway(): void {
  defaultGateway = null;
}
