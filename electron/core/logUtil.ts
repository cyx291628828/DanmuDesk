/**
 * ============================================================================
 * logUtil.ts — 日志工具（CLog）：控制台 + 文件双写
 * ============================================================================
 *  - 分 4 级：Debug(1) < Info(2) < Warn(3) < Error(4)，可通过 setLogLevel 过滤
 *  - 输出带 [时间] [等级] [调用文件:行号] 前缀（从调用栈解析），便于定位
 *  - 浏览器控制台使用彩色样式（%c），Node 主进程环境降级为纯文本
 *  - 【文件双写】主进程调用 CLog.setFileTarget(文件路径) 后，日志除控制台外
 *    还会批量落盘到文件（缓冲 500ms / 8KB 冲刷一次，应用退出前 flush 兜底），
 *    高频弹幕下不会拖慢主进程。运行时日志文件：开发=项目根/log/app.log，
 *    打包=userData/log/app.log
 *  - 用法：CLog.info('xxx', data) / CLog.warn(...) / CLog.error(...)
 * ============================================================================
 */
import * as fs from 'fs';
import * as path from 'path';

/** 单个日志文件大小上限（50MB）：超过则轮转为 app.log.1 并新建，防止无限增长 */
const FILE_MAX_SIZE = 50 * 1024 * 1024;

/**
 * 日志等级
 */
enum LogLevel {
  Debug = 1,
  Info = 2,
  Warn = 3,
  Error = 4
}

const levelNames: Record<LogLevel, string> = {
  [LogLevel.Debug]: 'DEBUG',
  [LogLevel.Info]: 'INFO',
  [LogLevel.Warn]: 'WARN',
  [LogLevel.Error]: 'ERROR'
};

const consoleMethod: Record<LogLevel, (...data: any[]) => void> = {
  // debug 会被浏览器默认隐藏
  // [LogLevel.Debug]: console.debug,
  [LogLevel.Debug]: console.log,
  [LogLevel.Info]: console.info,
  [LogLevel.Warn]: console.warn,
  [LogLevel.Error]: console.error
};

interface Trace {
  // 调用函数
  caller: string;
  // 文件路径
  location: string;
}

interface LogData {
  // 日志头
  header: string;
  // 样式
  style: string;
  // 输出数据
  args: any[];
}

const styles = {
  [LogLevel.Debug]: 'color: #6b798e',
  [LogLevel.Info]: 'color: #4994c4',
  [LogLevel.Warn]: 'color: #e9c46a',
  [LogLevel.Error]: 'color: #e94829'
};

interface LoggerConfig {
  prefix?: string;
  level?: LogLevel;
  // 是否输出栈
  trace?: boolean;
  // 是否可用
  enabled?: boolean;
}

/**
 * 自封装日志工具
 */
class Logger {
  /** 配置 */
  private prefix: string;
  private enabled: boolean;
  private level: LogLevel;
  private trace: boolean;
  /** 文件输出目标（null=只打控制台）；由主进程 setFileTarget 设置 */
  private fileTarget: string | null = null;
  /** 文件写入缓冲：攒够一批再落盘。高频弹幕场景下逐行 statSync+appendFileSync
   *  会拖慢主进程事件循环（每条消息 2~3 行日志 × 2 次系统调用），批量写后开销
   *  降到每 500ms 或每 8KB 一次 */
  private fileBuf: string[] = [];
  private fileBufBytes = 0;
  /** 当前日志文件近似字节数（内存记账，免掉每行 statSync） */
  private fileSize = 0;
  /** 连续写盘失败计数（≥5 次自动停用文件日志，防刷屏） */
  private fileErrors = 0;
  /** 定时冲刷器（即使日志稀疏也不让缓冲悬挂太久） */
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * 日志工具
   */
  constructor(config: LoggerConfig = {}) {
    this.prefix = config.prefix || '';
    this.enabled = config.enabled ?? true;
    this.level = config.level ?? LogLevel.Debug;
    this.trace = config.trace ?? true;
  }

  /**
   * 设置日志等级
   * @param level
   */
  public setLevel(level: LogLevel) {
    this.level = level;
  }

  /**
   * 设置是否输出调用栈
   * @param flag
   */
  public setTrace(flag: boolean) {
    this.trace = flag;
  }

  /**
   * 获取调用栈
   * @returns
   */
  private getTrace(origin?: string) {
    if (!origin) return null;
    const lines = origin.split('\n').map(l => l.trim());
    // 0: Error
    // 1: at Logger.getCallTrace ···
    // 2: at Logger.getLogPrefix ···
    // 3: at Logger._log ···
    // 4: at Logger.debug ···
    // 5: user code ···
    const stacks: Trace[] = [];
    lines.forEach(s => {
      let matchArray = s.match(/at (.+?) \((.+?)\)/);
      if (!matchArray) return;
      let name = matchArray[1];
      let location = matchArray[2];
      stacks.push({ caller: name, location });
    });
    if (stacks.length > 3) return stacks.slice(3);
    else return null;
  }

  /** 获取调用栈 */
  private getCallTrace() {
    const origin = new Error().stack;
    const stacks = this.getTrace(origin);
    if (!stacks) return 'unknown';
    const stack = stacks[1] || stacks[0];
    return stack.caller;
  }

  /** 是否需要输出 */
  private isLog(level: LogLevel) {
    return this.enabled && level >= this.level;
  }

  /** 获取输出前缀 */
  private getLogPrefix(level: LogLevel) {
    const time = this.formatDate(new Date(), 'yyyy-MM-dd HH:mm:ss.SSS');
    const prefixText = this.prefix ? `[${this.prefix}] ` : '';
    const LEVEL = `   ${levelNames[level]}`.slice(-7);
    const stack = this.trace ? ` --- [${this.getCallTrace()}]` : '';
    // 日志头
    const header = `%c${prefixText}${time} ${LEVEL}${stack}:`;
    // 样式
    const style = styles[level];
    return [header, style];
  }

  /**
   * 设置日志文件输出目标（主进程启动时调用一次）
   *  - 自动创建目录（log/ 或 userData/log/）
   *  - 设置后日志批量落盘（缓冲 500ms / 8KB），双击 exe 也能在文件里看运行日志
   * @param filePath 日志文件绝对路径，如 D:/xx/DanmuDesk/log/app.log
   */
  public setFileTarget(filePath: string) {
    this.flush(); // 切换目标前先冲刷旧缓冲
    this.fileTarget = filePath;
    this.fileSize = 0;
    this.fileErrors = 0;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      try {
        this.fileSize = fs.statSync(filePath).size;
      } catch {
        this.fileSize = 0; // 首次写入，文件不存在
      }
      if (this.fileSize > FILE_MAX_SIZE) this.rotateFile();
    } catch (err) {
      // 建目录失败（磁盘异常）就退化为纯控制台日志，不影响主流程
      console.warn('[logUtil] 创建日志目录失败，日志仅输出控制台:', err);
      this.fileTarget = null;
    }
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => this.flush(), 500);
      // unref：不阻止进程自然退出
      (this.flushTimer as any).unref?.();
    }
  }

  /** 立即把缓冲中的日志落盘（应用退出前 / 缓冲过大时调用） */
  public flush() {
    if (!this.fileTarget || !this.fileBuf.length) return;
    const chunk = this.fileBuf.join('\n') + '\n';
    this.fileBuf = [];
    this.fileBufBytes = 0;
    try {
      fs.appendFileSync(this.fileTarget, chunk, 'utf-8');
      this.fileSize += Buffer.byteLength(chunk, 'utf-8');
      this.fileErrors = 0;
      if (this.fileSize > FILE_MAX_SIZE) this.rotateFile();
    } catch (err) {
      // 磁盘满/权限变化等：连续失败 5 次停用文件日志（清空缓冲防内存堆积），保证业务不中断
      if (++this.fileErrors >= 5) {
        this.fileBuf = [];
        this.fileBufBytes = 0;
        this.fileTarget = null;
        console.warn('[logUtil] 日志文件连续写入失败，已停用文件日志:', err);
      } else {
        console.warn('[logUtil] 写日志文件失败:', err);
      }
    }
  }

  /** 轮转：旧文件改名 app.log.1（已存在则先删），下次写入自动新建 */
  private rotateFile() {
    if (!this.fileTarget) return;
    const bak = this.fileTarget + '.1';
    try {
      if (fs.existsSync(bak)) fs.unlinkSync(bak);
    } catch {}
    try {
      fs.renameSync(this.fileTarget, bak);
    } catch {
      /* Windows 偶发文件占用：改名失败则保持追加，下轮再试 */
    }
    this.fileSize = 0;
  }

  /**
   * 把日志参数序列化为可读字符串（写文件用，控制台保持原样传参）
   *  - 字符串原样保留；Error 输出堆栈；对象 JSON 序列化
   */
  private serializeArg(a: any): string {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object') {
      try {
        return JSON.stringify(a);
      } catch {
        /* 循环引用等无法序列化时降级为 String */
      }
    }
    return String(a);
  }

  /**
   * 把日志追加进写盘缓冲（批量落盘 + 大小轮转）
   *  - 只入队不写盘；flush() 在 500ms 定时 / 缓冲超 8KB / 应用退出时批量落盘
   *  - 轮转阈值 FILE_MAX_SIZE（50MB）：基于内存记账的 fileSize 判断，免去逐行 statSync
   */
  private appendToFile(text: string) {
    if (!this.fileTarget) return;
    this.fileBuf.push(text);
    this.fileBufBytes += text.length + 1;
    if (this.fileBufBytes >= 8192) this.flush();
  }

  /**
   * 输出日志
   * @param level
   * @param message
   */
  private _log(level: LogLevel, args: any[]) {
    if (!this.isLog(level)) return;
    const [header, style] = this.getLogPrefix(level);
    // 输出控制台
    this._console(level, {
      header,
      style,
      args
    });
    // 输出文件（去掉控制台专用的 %c 占位符，拼纯文本行）
    this._printFile(level, {
      header,
      style,
      args
    });
  }

  /**
   * 输出到控制台
   */
  private _console(level: LogLevel, data: LogData) {
    const { header, style, args } = data;
    const _printMethod = consoleMethod?.[level] || console.log;
    _printMethod(header, style, ...args);
  }

  /**
   * 记录到文件
   *  - header 含控制台专用 %c 占位符，写文件时去掉；args 逐项序列化
   *  - 每行格式：[时间] [等级] --- [调用函数]: 消息内容
   * @param level
   * @param data
   */
  private _printFile(level: LogLevel, data: LogData) {
    if (!this.fileTarget) return;
    const text = data.header.replace('%c', '') + ' ' + data.args.map((a) => this.serializeArg(a)).join(' ');
    this.appendToFile(text);
  }

  /**
   * 格式化日期
   * @param date {Date} 日期
   * @param format {string} 格式化字符串
   *   - y:年，M:月，d:日
   *   - h:时(12)，H:时(24)，m:分，s:秒
   *   - q:季度，a:上午|下午，A:AM|PM
   *   - w:星期(EN)，W:星期(CN)
   *   - 例：'yyyy-MM-dd W' = '1970-01-01 星期四'
   */
  private formatDate(date: Date, format: string = 'HH:mm') {
    const re = /(y+)/;
    if (re.test(format)) {
      const t = re.exec(format)![1];
      format = format.replace(t, (date.getFullYear() + '').substring(4 - t.length));
    }
    const CW = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    const EW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const o: Record<string, number | string> = {
      'M+': date.getMonth() + 1, // 月
      'd+': date.getDate(), // 日
      'h+': date.getHours() % 12 === 0 ? 12 : date.getHours() % 12, // 小时[12]
      'H+': date.getHours(), // 小时[24]
      'm+': date.getMinutes(), // 分
      's+': date.getSeconds(), // 秒
      'q+': Math.floor((date.getMonth() + 3) / 3), // 季度
      'S+': date.getMilliseconds(), // 毫秒
      a: date.getHours() < 12 ? '上午' : '下午', // 上午/下午
      A: date.getHours() < 12 ? 'AM' : 'PM', // AM/PM
      w: EW[date.getDay()],
      W: CW[date.getDay()]
    };
    for (let k in o) {
      const regx = new RegExp('(' + k + ')');
      if (regx.test(format)) {
        const t = regx.exec(format)![1];
        format = format.replace(t, t.length === 1 ? `${o[k]}` : `00${o[k]}`.slice(t.length * -1));
      }
    }
    return format;
  }

  /**
   * 开发日志
   * @param message
   */
  public debug(...message: any[]) {
    this._log(LogLevel.Debug, message);
  }

  /**
   * 消息日志
   * @param params
   */
  public info(...message: any[]) {
    this._log(LogLevel.Info, message);
  }

  /**
   * 警告日志
   * @param params
   */
  public warn(...message: any[]) {
    this._log(LogLevel.Warn, message);
  }

  /**
   * 错误日志
   * @param params
   */
  public error(...message: any[]) {
    this._log(LogLevel.Error, message);
  }
}

function test() {
  const MLog = new Logger({ prefix: 'dycast' });
  MLog.debug('debug message');
  MLog.info('info message');
  MLog.warn('warning message');
  MLog.error('error message');
}

/**
 * 输出标签
 * @param tip
 * @param link
 * @param color
 */
export const printInfo = function (
  tip: string = '抖音弹幕姬',
  link: string = 'https://github.com/skmcj/dycast',
  color: string = '#fe2c55'
) {
  console.log(
    `%c ${tip} %c ${link}`,
    `color:white;background:${color};padding:5px 0;border-radius: 5px 0 0 5px;`,
    `padding:4px;border:1px solid ${color};border-radius: 0 5px 5px 0;`
  );
};

export const printSKMCJ = function () {
  const info = `
 ________  ___  __    _____ ______   ________        ___     
|\\   ____\\|\\  \\|\\  \\ |\\   _ \\  _   \\|\\   ____\\      |\\  \\    
\\ \\  \\___|\\ \\  \\/  /|\\ \\  \\\\\\__\\ \\  \\ \\  \\___|      \\ \\  \\   
 \\ \\_____  \\ \\   ___  \\ \\  \\\\|__| \\  \\ \\  \\       __ \\ \\  \\  
  \\|____|\\  \\ \\  \\\\ \\  \\ \\  \\    \\ \\  \\ \\  \\____ |\\  \\\\_\\  \\ 
    ____\\_\\  \\ \\__\\\\ \\__\\ \\__\\    \\ \\__\\ \\_______\\ \\________\\
   |\\_________\\|__| \\|__|\\|__|     \\|__|\\|_______|\\|________|
   \\|_________|
  `;
  console.log(`%c${info}`, `color: #00faf0`);
};

export const CLog = new Logger({ prefix: 'dycast' });
// RLog.setLevel(LogLevel.error);
