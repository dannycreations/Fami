import { join } from 'node:path';
import { isErrorLike } from '@vegapunk/utilities/result';
import { Cause, Layer, Logger, LogLevel, Schema } from 'effect';
import pino from 'pino';
import pinoPretty from 'pino-pretty';

import type { ReadonlyRecord } from 'effect/Record';
import type { Level, StreamEntry } from 'pino';

export const PINO_LEVEL_MAP: ReadonlyRecord<string, LogLevel.LogLevel> = {
  trace: LogLevel.Trace,
  debug: LogLevel.Debug,
  info: LogLevel.Info,
  warn: LogLevel.Warning,
  error: LogLevel.Error,
  fatal: LogLevel.Fatal,
  silent: LogLevel.None,
};

export const EFFECT_LEVEL_MAP: ReadonlyRecord<LogLevel.LogLevel['_tag'], pino.LevelWithSilent> = {
  All: 'trace',
  Trace: 'trace',
  Debug: 'debug',
  Info: 'info',
  Warning: 'warn',
  Error: 'error',
  Fatal: 'fatal',
  None: 'silent',
};

export const LoggerOptions = Schema.Struct({
  dir: Schema.optional(Schema.String),
  level: Schema.optional(Schema.String as unknown as Schema.Schema<Level, string>),
  trace: Schema.optional(Schema.Boolean),
  pretty: Schema.optional(Schema.Boolean),
  exception: Schema.optional(Schema.Boolean),
  rejection: Schema.optional(Schema.Boolean),
});

export type LoggerOptions = Schema.Schema.Type<typeof LoggerOptions>;

export const makeLoggerClient = (options: LoggerOptions = {}): pino.Logger => {
  const {
    dir = join(process.cwd(), 'logs'),
    level = (process.env.NODE_ENV === 'development' ? 'debug' : 'info') as Level,
    trace = false,
    pretty = true,
    exception = true,
    rejection = true,
  } = options;

  const streams: ReadonlyArray<StreamEntry> = [
    {
      level: 'warn',
      stream: pino.destination({
        mkdir: true,
        dest: join(dir, 'errors.log'),
      }),
    },
    ...(trace
      ? [
          {
            level: 'trace' as const,
            stream: pino.destination({
              mkdir: true,
              dest: join(dir, 'traces.log'),
            }),
          },
        ]
      : []),
    pretty
      ? ({
          level,
          stream: pinoPretty({
            colorize: true,
            translateTime: 'SYS:HH:MM:ss',
            sync: process.env.NODE_ENV === 'development',
            singleLine: process.env.NODE_ENV === 'production',
          }),
        } as StreamEntry)
      : ({
          level,
          stream: process.stdout,
        } as StreamEntry),
  ];

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
    pino.multistream(streams as StreamEntry[]),
  );

  if (exception && process.listenerCount('uncaughtException') === 0) {
    process.on('uncaughtException', (error, origin) => {
      instance.fatal({ error, origin }, 'UncaughtException');
    });
  }

  if (rejection && process.listenerCount('unhandledRejection') === 0) {
    process.on('unhandledRejection', (reason, promise) => {
      instance.fatal({ reason, promise }, 'UnhandledRejection');
    });
  }

  return instance;
};

export const LoggerClientLayer = (self: Logger.Logger<unknown, void>, logger: pino.Logger): Layer.Layer<never> =>
  Layer.mergeAll(
    Logger.replace(
      self,
      Logger.make(({ logLevel, message, cause }) => {
        const level = EFFECT_LEVEL_MAP[logLevel._tag] ?? 'info';
        const payload = Array.isArray(message) ? [...message] : [message];

        if (cause && !Cause.isEmptyType(cause)) {
          const [failure] = Cause.failures(cause);
          const causePretty = { cause: Cause.pretty(cause) };

          if (isErrorLike<{ readonly cause: unknown }>(failure) && failure.cause) {
            payload.push({ ...(failure.cause as object), ...causePretty });
          } else {
            payload.push(causePretty);
          }
        }

        const logMethod = logger[level] as (...args: readonly unknown[]) => void;
        logMethod.call(logger, ...payload);
      }),
    ),
    Logger.minimumLogLevel(PINO_LEVEL_MAP[logger.level] ?? LogLevel.Info),
  );
