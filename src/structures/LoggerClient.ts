import { join } from 'node:path';
import { isErrorLike } from '@vegapunk/utilities/result';
import { Cause, Layer, Logger, LogLevel } from 'effect';
import pino from 'pino';
import pinoPretty from 'pino-pretty';

import type { ReadonlyRecord } from 'effect/Record';
import type { Level, Logger as LoggerPino, StreamEntry } from 'pino';

export const LOG_LEVEL_MAP: ReadonlyRecord<LogLevel.LogLevel['_tag'], pino.LevelWithSilent> = {
  All: 'trace',
  Trace: 'trace',
  Debug: 'debug',
  Info: 'info',
  Warning: 'warn',
  Error: 'error',
  Fatal: 'fatal',
  None: 'silent',
};

export interface LoggerOptions {
  readonly dir?: string;
  readonly level?: Level;
  readonly trace?: boolean;
  readonly pretty?: boolean;
  readonly exception?: boolean;
  readonly rejection?: boolean;
}

export const createLogger = (options: LoggerOptions = {}): LoggerPino => {
  const {
    dir = join(process.cwd(), 'logs'),
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
        dest: `${dir}/errors.log`,
      }),
    },
  ];

  if (trace) {
    streams.push({
      level: 'trace',
      stream: pino.destination({
        mkdir: true,
        dest: `${dir}/traces.log`,
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

export const LoggerClientLayer = (self: Logger.Logger<unknown, void>, logger: pino.Logger): Layer.Layer<never> =>
  Logger.replace(
    self,
    Logger.make(({ logLevel, message, cause }) => {
      const level = LOG_LEVEL_MAP[logLevel._tag] ?? 'info';
      const payload = Array.isArray(message) ? [...message] : [message];

      if (cause && !Cause.isEmptyType(cause)) {
        const [failure] = Cause.failures(cause);
        const causePretty = { cause: Cause.pretty(cause) };
        if (isErrorLike<{ cause: unknown }>(failure) && failure.cause) {
          payload.push(Object.assign({}, failure.cause, causePretty));
        } else {
          payload.push(causePretty);
        }
      }

      (logger[level] as (...args: unknown[]) => void)(...payload);
    }),
  );
