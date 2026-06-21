/**
 * CloudSave API - 云存档系统
 */

import type { AllinONEGame } from '../index';
import { getCachedToken } from './tokenManager';

export interface SaveData {
  slot: number;
  timestamp: number;
  data: any;
  checksum?: string;
}

export class CloudSaveAPI {
  private game: AllinONEGame;
  private initialized: boolean = false;
  private maxSlots: number = 3;

  constructor(game: AllinONEGame) {
    this.game = game;
  }

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  /**
   * 保存到云端
   */
  async save(data: any, slot: number = 1): Promise<boolean> {
    if (slot < 1 || slot > this.maxSlots) {
      console.error(`Invalid save slot: ${slot}`);
      return false;
    }

    try {
      const token = this.getToken();
      if (!token) {
        console.warn('No auth token, saving locally only');
        this.saveLocal(data, slot);
        return true;
      }

      const saveData: SaveData = {
        slot,
        timestamp: Date.now(),
        data,
        checksum: this.generateChecksum(data),
      };

      const response = await fetch('/api/cloudsave/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          gameId: this.getGameId(),
          ...saveData,
        }),
      });

      const result = await response.json();

      if (result.success) {
        this.saveLocal(data, slot);
        return true;
      }

      return false;
    } catch (error) {
      console.error('Failed to save to cloud:', error);
      // 失败时保存到本地
      this.saveLocal(data, slot);
      return true;
    }
  }

  /**
   * 从云端加载
   */
  async load(slot: number = 1): Promise<any | null> {
    if (slot < 1 || slot > this.maxSlots) {
      console.error(`Invalid save slot: ${slot}`);
      return null;
    }

    try {
      const token = this.getToken();
      if (!token) {
        console.warn('No auth token, loading from local');
        return this.loadLocal(slot);
      }

      const response = await fetch(`/api/cloudsave/load?gameId=${this.getGameId()}&slot=${slot}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      const result = await response.json();

      if (result.success && result.data) {
        // 验证校验和
        if (result.data.checksum && result.data.checksum !== this.generateChecksum(result.data.data)) {
          console.warn('Save data checksum mismatch');
        }

        // 同步到本地
        this.saveLocal(result.data.data, slot);

        return result.data.data;
      }

      return null;
    } catch (error) {
      console.error('Failed to load from cloud:', error);
      // 失败时从本地加载
      return this.loadLocal(slot);
    }
  }

  /**
   * 获取所有存档槽信息
   */
  async getSaveSlots(): Promise<Array<{ slot: number; timestamp: number | null; hasData: boolean }>> {
    const slots: Array<{ slot: number; timestamp: number | null; hasData: boolean }> = [];

    for (let i = 1; i <= this.maxSlots; i++) {
      const localData = this.loadLocal(i);
      slots.push({
        slot: i,
        timestamp: localData?.timestamp || null,
        hasData: localData !== null,
      });
    }

    // 尝试从云端获取更准确的存档信息
    try {
      const token = this.getToken();
      if (token) {
        const response = await fetch(`/api/cloudsave/slots?gameId=${this.getGameId()}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        });

        const result = await response.json();

        if (result.success && result.slots) {
          result.slots.forEach((slot: any) => {
            const existing = slots.find(s => s.slot === slot.slot);
            if (existing) {
              existing.timestamp = slot.timestamp;
              existing.hasData = true;
            }
          });
        }
      }
    } catch (error) {
      // 忽略云同步错误，使用本地数据
    }

    return slots;
  }

  /**
   * 删除存档
   */
  async delete(slot: number): Promise<boolean> {
    if (slot < 1 || slot > this.maxSlots) {
      return false;
    }

    // 删除本地存档
    localStorage.removeItem(`allinone_cloudsave_${this.getGameId()}_${slot}`);

    try {
      const token = this.getToken();
      if (!token) return true;

      const response = await fetch('/api/cloudsave/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          gameId: this.getGameId(),
          slot,
        }),
      });

      const result = await response.json();
      return result.success;
    } catch (error) {
      console.error('Failed to delete cloud save:', error);
      return true; // 本地删除成功
    }
  }

  /**
   * 同步存档
   */
  async sync(): Promise<void> {
    try {
      const token = this.getToken();
      if (!token) return;

      const response = await fetch(`/api/cloudsave/sync?gameId=${this.getGameId()}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      const result = await response.json();

      if (result.success && result.saves) {
        // 更新本地存档
        result.saves.forEach((save: SaveData) => {
          this.saveLocal(save.data, save.slot);
        });
      }
    } catch (error) {
      console.error('Failed to sync saves:', error);
    }
  }

  // ==================== 私有方法 ====================

  private saveLocal(data: any, slot: number): void {
    const saveData: SaveData = {
      slot,
      timestamp: Date.now(),
      data,
    };

    localStorage.setItem(
      `allinone_cloudsave_${this.getGameId()}_${slot}`,
      JSON.stringify(saveData)
    );
  }

  private loadLocal(slot: number): any | null {
    const saved = localStorage.getItem(`allinone_cloudsave_${this.getGameId()}_${slot}`);
    if (saved) {
      try {
        const saveData: SaveData = JSON.parse(saved);
        return saveData.data;
      } catch {
        return null;
      }
    }
    return null;
  }

  private generateChecksum(data: any): string {
    // 简单的校验和生成
    const str = JSON.stringify(data);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(16);
  }

  private getGameId(): string {
    return (this.game as any).getConfig().gameId;
  }

  private getToken(): string | null {
    return localStorage.getItem('allinone_token');
  }
}
