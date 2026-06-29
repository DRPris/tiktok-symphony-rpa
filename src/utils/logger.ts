/**
 * 简单的带时间戳和级别的日志工具
 * 格式: [2024-01-01 12:00:00] [LEVEL] [module] message
 */

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_LEVELS: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

let currentLevel: LogLevel = 'INFO';

function getTimestamp(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function formatMessage(level: LogLevel, module: string, message: string): string {
  return `[${getTimestamp()}] [${level}] [${module}] ${message}`;
}

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function createLogger(module: string) {
  return {
    debug(message: string, ...args: any[]): void {
      if (shouldLog('DEBUG')) {
        console.log(formatMessage('DEBUG', module, message), ...args);
      }
    },
    info(message: string, ...args: any[]): void {
      if (shouldLog('INFO')) {
        console.log(formatMessage('INFO', module, message), ...args);
      }
    },
    warn(message: string, ...args: any[]): void {
      if (shouldLog('WARN')) {
        console.warn(formatMessage('WARN', module, message), ...args);
      }
    },
    error(message: string, ...args: any[]): void {
      if (shouldLog('ERROR')) {
        console.error(formatMessage('ERROR', module, message), ...args);
      }
    },
  };
}
