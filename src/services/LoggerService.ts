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
  options = {
    level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
    trace: false,
    pretty: true,
    exception: true,
    rejection: true,
    ...options,
  };

  const streams: StreamEntry[] = [
    {
      level: 'warn',
      stream: pino.destination({
        mkdir: true,
        dest: `${process.cwd()}/logs/errors.log`,
      }),
    },
  ];

  if (options.trace) {
    streams.push({
      level: 'trace',
      stream: pino.destination({
        mkdir: true,
        dest: `${process.cwd()}/logs/traces.log`,
      }),
    });
  }
  if (options.pretty) {
    streams.push({
      level: options.level,
      stream: pinoPretty({
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',
        sync: process.env.NODE_ENV === 'development',
        singleLine: process.env.NODE_ENV === 'production',
      }),
    });
  } else {
    streams.push({
      level: options.level,
      stream: process.stdout,
    });
  }

  const instance = pino(
    {
      level: options.level,
      base: undefined,
      nestedKey: 'payload',
    },
    pino.multistream(streams),
  );

  if (options.exception) {
    process.on('uncaughtException', (error, origin) => {
      instance.fatal({ error, origin }, 'UncaughtException');
    });
  }

  if (options.rejection) {
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
    Logger.make(({ logLevel, message, annotations, cause }) => {
      const level = mapLogLevel(logLevel);
      const msg = Array.isArray(message) ? message.join(' ') : typeof message === 'string' ? message : JSON.stringify(message);
      const payload: Record<string, unknown> = {
        ...Object.fromEntries(annotations),
      };

      if (cause && cause._tag !== 'Empty') {
        payload.cause = cause;
      }

      logger[level](payload, msg);
    }),
  );

const defaultLogger = createLogger({
  exception: false,
  rejection: false,
});

export const LoggerLive = createEffectLogger(Logger.defaultLogger, defaultLogger);
