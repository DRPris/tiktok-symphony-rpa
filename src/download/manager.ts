import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { VideoTask } from '../types';

/**
 * 下载管理器
 * 管理视频文件的下载路径、移动和临时文件清理
 */
export class DownloadManager {
  private tempDir: string;

  constructor() {
    this.tempDir = path.join(config.download.dir, '.temp');
    this.ensureDir(config.download.dir);
    this.ensureDir(this.tempDir);
  }

  /**
   * 根据任务信息生成下载路径
   * 格式：downloads/{日期}/{productName}_{taskId短码}.mp4
   */
  getDownloadPath(task: VideoTask): string {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const shortId = task.id.slice(0, 8);
    const safeName = this.sanitizeFilename(task.input.productName);
    const dir = path.join(config.download.dir, date);

    this.ensureDir(dir);

    const filename = `${safeName}_${shortId}.mp4`;
    return path.join(dir, filename);
  }

  /**
   * 将临时下载文件移动到最终位置
   */
  async moveToFinalLocation(tempPath: string, task: VideoTask): Promise<string> {
    const finalPath = this.getDownloadPath(task);

    console.log(`[DownloadManager] 移动文件: ${tempPath} -> ${finalPath}`);

    // 确保目标目录存在
    const dir = path.dirname(finalPath);
    this.ensureDir(dir);

    // 复制文件到目标位置
    await fs.promises.copyFile(tempPath, finalPath);

    // 删除临时文件
    try {
      await fs.promises.unlink(tempPath);
    } catch (err) {
      console.warn(`[DownloadManager] 清理临时文件失败: ${tempPath}`, err);
    }

    console.log(`[DownloadManager] 文件已保存: ${finalPath}`);
    return finalPath;
  }

  /**
   * 清理临时下载文件
   */
  async cleanupTempFiles(): Promise<void> {
    console.log(`[DownloadManager] 清理临时文件目录: ${this.tempDir}`);

    if (!fs.existsSync(this.tempDir)) {
      return;
    }

    const files = await fs.promises.readdir(this.tempDir);
    let cleaned = 0;

    for (const file of files) {
      const filePath = path.join(this.tempDir, file);
      try {
        const stat = await fs.promises.stat(filePath);
        // 清理超过 1 小时的临时文件
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs > 60 * 60 * 1000) {
          await fs.promises.unlink(filePath);
          cleaned++;
        }
      } catch (err) {
        console.warn(`[DownloadManager] 清理失败: ${filePath}`, err);
      }
    }

    console.log(`[DownloadManager] 已清理 ${cleaned} 个临时文件`);
  }

  /**
   * 确保目录存在
   */
  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * 清理文件名中的非法字符
   */
  private sanitizeFilename(name: string): string {
    return name
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 50)
      .replace(/^_|_$/g, '');
  }
}
