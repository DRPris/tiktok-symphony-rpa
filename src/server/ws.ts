import WebSocket, { WebSocketServer as WSServer } from 'ws';
import { TaskManager } from '../task/manager';
import { VideoTask, TaskStatus, SystemStatus } from '../types';

/**
 * 推送消息类型
 */
export type WsMessageType =
  | 'task:created'
  | 'task:statusChanged'
  | 'task:completed'
  | 'task:failed'
  | 'system:status'
  | 'init';

export interface WsMessage {
  type: WsMessageType;
  data: VideoTask | SystemStatus | VideoTask[] | object;
  timestamp?: string;
}

/**
 * WebSocketServer - 向审核面板实时推送任务状态变更
 */
export class WebSocketServer {
  private taskManager: TaskManager;
  private port: number;
  private wss: WSServer | null = null;
  private clients: Set<WebSocket> = new Set();

  // 保存事件监听器引用，便于停止时移除
  private listeners: Array<{ event: string; handler: (...args: any[]) => void }> = [];

  // 系统状态推送定时器
  private statusInterval: NodeJS.Timeout | null = null;

  constructor(taskManager: TaskManager, port: number) {
    this.taskManager = taskManager;
    this.port = port;
  }

  /**
   * 启动 WebSocket 服务
   */
  start(): void {
    if (this.wss) {
      console.log('[WS] 服务已在运行');
      return;
    }

    this.wss = new WSServer({ port: this.port });

    this.wss.on('connection', (ws, req) => {
      const remote = req.socket.remoteAddress || 'unknown';
      this.clients.add(ws);
      console.log(`[WS] 客户端连接: ${remote} (当前连接数: ${this.clients.size})`);

      // 发送初始状态
      this.sendInitialState(ws).catch((err) => {
        console.error('[WS] 发送初始状态失败:', err.message);
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        console.log(`[WS] 客户端断开: ${remote} (当前连接数: ${this.clients.size})`);
      });

      ws.on('error', (err) => {
        console.error(`[WS] 客户端错误 ${remote}:`, err.message);
        this.clients.delete(ws);
      });
    });

    this.wss.on('error', (err) => {
      console.error('[WS] 服务器错误:', err.message);
    });

    // 注册 TaskManager 事件监听
    this.registerTaskManagerListeners();

    // 定期推送系统状态
    this.statusInterval = setInterval(() => {
      this.broadcastSystemStatus().catch((err) => {
        console.error('[WS] 推送系统状态失败:', err.message);
      });
    }, 5000);

    console.log(`[WS] WebSocket 服务启动在端口 ${this.port}`);
  }

  /**
   * 注册 TaskManager 事件
   */
  private registerTaskManagerListeners(): void {
    const onCreated = (task: VideoTask) => {
      this.broadcast({ type: 'task:created', data: task });
    };

    const onStatusChanged = (task: VideoTask, _oldStatus: TaskStatus) => {
      this.broadcast({ type: 'task:statusChanged', data: task });
    };

    const onCompleted = (task: VideoTask) => {
      this.broadcast({ type: 'task:completed', data: task });
    };

    const onFailed = (task: VideoTask) => {
      this.broadcast({ type: 'task:failed', data: task });
    };

    this.taskManager.on('task:created', onCreated);
    this.taskManager.on('task:statusChanged', onStatusChanged);
    this.taskManager.on('task:completed', onCompleted);
    this.taskManager.on('task:failed', onFailed);

    this.listeners.push(
      { event: 'task:created', handler: onCreated },
      { event: 'task:statusChanged', handler: onStatusChanged },
      { event: 'task:completed', handler: onCompleted },
      { event: 'task:failed', handler: onFailed }
    );
  }

  /**
   * 发送当前所有任务的初始状态给新连接客户端
   */
  private async sendInitialState(ws: WebSocket): Promise<void> {
    try {
      const tasks = await this.taskManager.getAllTasks();
      const status = await this.taskManager.getSystemStatus();
      const message: WsMessage = {
        type: 'init',
        data: { tasks, status },
        timestamp: new Date().toISOString(),
      };
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    } catch (err: any) {
      console.error('[WS] 获取初始状态失败:', err.message);
    }
  }

  /**
   * 广播消息给所有连接的客户端
   */
  broadcast(message: object): void {
    const payload = JSON.stringify({
      ...message,
      timestamp: new Date().toISOString(),
    });

    let sent = 0;
    let failed = 0;
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(payload);
          sent++;
        } catch (err: any) {
          failed++;
          console.error('[WS] 发送消息失败:', err.message);
        }
      }
    }

    if (failed > 0) {
      console.warn(`[WS] 广播完成: 成功 ${sent}, 失败 ${failed}`);
    }
  }

  /**
   * 推送系统状态
   */
  private async broadcastSystemStatus(): Promise<void> {
    if (this.clients.size === 0) return;
    const status = await this.taskManager.getSystemStatus();
    this.broadcast({ type: 'system:status', data: status });
  }

  /**
   * 获取当前连接数
   */
  getConnectedClients(): number {
    return this.clients.size;
  }

  /**
   * 停止 WebSocket 服务
   */
  stop(): void {
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }

    // 移除 TaskManager 事件监听
    for (const { event, handler } of this.listeners) {
      this.taskManager.off(event, handler);
    }
    this.listeners = [];

    // 关闭所有客户端连接
    for (const client of this.clients) {
      try {
        client.close();
      } catch {
        // ignore
      }
    }
    this.clients.clear();

    if (this.wss) {
      this.wss.close(() => {
        console.log('[WS] WebSocket 服务已关闭');
      });
      this.wss = null;
    }
  }
}
