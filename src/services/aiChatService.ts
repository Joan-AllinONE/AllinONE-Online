// AI聊天服务 - 支持多种AI模型
export interface AIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface AIConfig {
  provider: 'openai' | 'claude' | 'gemini' | 'local';
  apiKey?: string;
  model?: string;
  baseURL?: string;
}

class AIChatService {
  private config: AIConfig;
  private conversationHistory: Map<string, AIMessage[]> = new Map();

  constructor() {
    // 默认配置，可以通过设置界面修改
    // API Key 使用 sessionStorage（页面关闭自动清除，避免持久化泄露）
    this.config = {
      provider: 'openai',
      model: 'gpt-3.5-turbo',
      apiKey: sessionStorage.getItem('ai_api_key') || '',
      baseURL: sessionStorage.getItem('ai_base_url') || 'https://api.openai.com/v1'
    };
  }

  // 更新AI配置
  updateConfig(newConfig: Partial<AIConfig>) {
    this.config = { ...this.config, ...newConfig };
    if (newConfig.apiKey) {
      sessionStorage.setItem('ai_api_key', newConfig.apiKey);
    }
    if (newConfig.baseURL) {
      sessionStorage.setItem('ai_base_url', newConfig.baseURL);
    }
  }

  // 获取当前配置
  getConfig(): AIConfig {
    return { ...this.config };
  }

  // 发送消息给AI
  async sendMessage(conversationId: string, message: string, context?: string): Promise<string> {
    try {
      // 获取对话历史
      const history = this.conversationHistory.get(conversationId) || [];
      
      // 添加用户消息
      const userMessage: AIMessage = {
        role: 'user',
        content: message,
        timestamp: Date.now()
      };
      
      // 构建消息数组
      const messages = [
        {
          role: 'system',
          content: this.getSystemPrompt(context)
        },
        ...history.slice(-10), // 只保留最近10条消息作为上下文
        userMessage
      ];

      let response: string;

      switch (this.config.provider) {
        case 'openai':
          response = await this.callOpenAI(messages);
          break;
        case 'claude':
          response = await this.callClaude(messages);
          break;
        case 'gemini':
          response = await this.callGemini(messages);
          break;
        case 'local':
          response = await this.callLocalModel(messages);
          break;
        default:
          throw new Error('不支持的AI提供商');
      }

      // 保存对话历史
      const assistantMessage: AIMessage = {
        role: 'assistant',
        content: response,
        timestamp: Date.now()
      };

      history.push(userMessage, assistantMessage);
      this.conversationHistory.set(conversationId, history);

      return response;
    } catch (error) {
      console.error('AI聊天服务错误:', error);
      return this.getFallbackResponse(message);
    }
  }

  // OpenAI API调用
  private async callOpenAI(messages: any[]): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error('请先配置OpenAI API Key');
    }

    const response = await fetch(`${this.config.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        model: this.config.model || 'gpt-3.5-turbo',
        messages: messages,
        max_tokens: 500,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API错误: ${response.status}`);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || '抱歉，我现在无法回复。';
  }

  // Claude API调用
  private async callClaude(messages: any[]): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error('请先配置Claude API Key');
    }

    // Claude API实现
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: this.config.model || 'claude-3-sonnet-20240229',
        max_tokens: 500,
        messages: messages.filter(m => m.role !== 'system'),
        system: messages.find(m => m.role === 'system')?.content
      })
    });

    if (!response.ok) {
      throw new Error(`Claude API错误: ${response.status}`);
    }

    const data = await response.json();
    return data.content[0]?.text || '抱歉，我现在无法回复。';
  }

  // Gemini API调用
  private async callGemini(messages: any[]): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error('请先配置Gemini API Key');
    }

    // 转换消息格式
    const contents = messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${this.config.apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: contents,
        generationConfig: {
          maxOutputTokens: 500,
          temperature: 0.7
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Gemini API错误: ${response.status}`);
    }

    const data = await response.json();
    return data.candidates[0]?.content?.parts[0]?.text || '抱歉，我现在无法回复。';
  }

  // 本地模型调用（如Ollama）
  private async callLocalModel(messages: any[]): Promise<string> {
    const baseURL = this.config.baseURL || 'http://localhost:11434';
    
    const response = await fetch(`${baseURL}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.config.model || 'llama2',
        messages: messages,
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(`本地模型错误: ${response.status}`);
    }

    const data = await response.json();
    return data.message?.content || '抱歉，我现在无法回复。';
  }

  // 获取系统提示词
  private getSystemPrompt(context?: string): string {
    const basePrompt = `你是AllinONE游戏平台中的智能NPC助手。你需要：
1. 保持友好、有趣的游戏角色形象
2. 帮助玩家了解游戏功能和交易系统
3. 提供游戏建议和策略指导
4. 与玩家进行自然的对话交流
5. 回复要简洁明了，适合游戏聊天环境

请用中文回复，保持轻松愉快的语调。`;

    if (context) {
      return `${basePrompt}\n\n当前上下文：${context}`;
    }

    return basePrompt;
  }

  // 备用回复（当AI服务不可用时）
  private getFallbackResponse(message: string): string {
    const fallbacks = [
      '哈哈，你说得很有趣！我正在思考怎么回复你...',
      '这个问题很棒！让我想想...',
      '你好！我是游戏助手，很高兴和你聊天！',
      '嗯嗯，我明白你的意思，不过我现在有点忙，稍后再详细聊？',
      '哇，你真厉害！继续加油哦！',
      '有什么游戏问题可以问我，我很乐意帮助你！'
    ];
    
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }

  // 清除对话历史
  clearConversation(conversationId: string) {
    this.conversationHistory.delete(conversationId);
  }

  // 获取对话历史
  getConversationHistory(conversationId: string): AIMessage[] {
    return this.conversationHistory.get(conversationId) || [];
  }
}

export const aiChatService = new AIChatService();