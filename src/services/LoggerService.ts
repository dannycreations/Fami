import { Logger, LogLevel } from 'effect';
import pino from 'pino';
import pinoPretty from 'pino-pretty';

import type { Level, Logger as LoggerPino, StreamEntry } from 'pino';

interface LoggerOptions {
  readonly level?: Level;
  readonly trace?: boolean;
  readonly pretty?: boolean;
  readonly exception?: boolean;
  readonly rejection?: boolean;
}

const createLogger = (options: LoggerOptions = {}): LoggerPino => {
  const {
    level = process.env.NODE_ENV === 'development' ? 'debug' : 'info',
    trace = false,
    pretty = true,
    exception = true,
    rejection = true,
  } = options;

  const streams: StreamEntry[] = [
    {
      level: 'warn',
      stream: pino.destination({
        mkdir: true,
        dest: `${process.cwd()}/logs/errors.log`,
      }),
    },
  ];

  if (trace) {
    streams.push({
      level: 'trace',
      stream: pino.destination({
        mkdir: true,
        dest: `${process.cwd()}/logs/traces.log`,
      }),
    });
  }

  if (pretty) {
    streams.push({
      level,
      stream: pinoPretty({
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',
        sync: process.env.NODE_ENV === 'development',
        singleLine: process.env.NODE_ENV === 'production',
      }),
    });
  } else {
    streams.push({
      level,
      stream: process.stdout,
    });
  }

  const instance = pino(
    {
      level,
      base: undefined,
      nestedKey: 'payload',
      hooks: {
        logMethod(args, method) {
          if (args.length >= 2) {
            const [arg0, arg1, ...rest] = args;
            if (typeof arg0 === 'string' && typeof arg1 === 'object') {
              return method.apply(this, [arg1, arg0, ...rest]);
            }

            if (args.every((r) => typeof r === 'string')) {
              return method.apply(this, [args.join(' ')]);
            }
          }
          return method.apply(this, args);
        },
      },
    },
    pino.multistream(streams),
  );

  if (exception) {
    process.on('uncaughtException', (error, origin) => {
      instance.fatal({ error, origin }, 'UncaughtException');
    });
  }

  if (rejection) {
    process.on('unhandledRejection', (reason, promise) => {
      instance.fatal({ reason, promise }, 'UnhandledRejection');
    });
  }

  return instance;
};

const mapLogLevel = (level: LogLevel.LogLevel): pino.LevelWithSilent => {
  switch (level._tag) {
    case 'All':
      return 'trace';
    case 'Trace':
      return 'trace';
    case 'Debug':
      return 'debug';
    case 'Info':
      return 'info';
    case 'Warning':
      return 'warn';
    case 'Error':
      return 'error';
    case 'Fatal':
      return 'fatal';
    case 'None':
      return 'silent';
    default:
      return 'info';
  }
};

const createEffectLogger = (self: Logger.Logger<unknown, void>, logger: pino.Logger) =>
  Logger.replace(
    self,
    Logger.make(({ logLevel, message, cause }) => {
      const level = mapLogLevel(logLevel);
      const payload = Array.isArray(message) ? [...message] : [message];

      if (cause && cause._tag !== 'Empty') {
        payload.push({ cause });
      }

      (logger[level] as Function)(...payload);
    }),
  );

const defaultLogger = createLogger({
  exception: false,
  rejection: false,
});

export const LoggerLive = createEffectLogger(Logger.defaultLogger, defaultLogger);
