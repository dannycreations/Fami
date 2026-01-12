import { lookup } from 'node:dns/promises';
import { defaultsDeep } from '@vegapunk/utilities/common';
import { isErrorLike } from '@vegapunk/utilities/result';
import { Context, Data, Effect, Layer, Schedule } from 'effect';
import got from 'got';
import UserAgent from 'user-agents';

import type { CancelableRequest, Got, Options, RequestError, Response } from 'got';

export class HttpRequestError extends Data.TaggedError('HttpRequestError')<{
  readonly message: string;
  readonly code?: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

export const ERROR_CODES: readonly string[] = [
  'EADDRINUSE',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ERR_CANCELED',
  'ECONNABORTED',
  'UND_ERR_CONNECT_TIMEOUT',
];

export const ERROR_STATUS_CODES: readonly number[] = [408, 413, 429, 500, 502, 503, 504, 521, 522, 524];

export interface DefaultOptions extends Omit<Options, 'prefixUrl' | 'retry' | 'timeout' | 'resolveBodyOnly'> {
  readonly retry?: number;
  readonly timeout?: Partial<{
    readonly initial: number;
    readonly transmission: number;
    readonly total: number;
  }>;
}

export interface HttpLayer {
  readonly request: <T = string>(options: string | DefaultOptions) => Effect.Effect<Response<T>, HttpRequestError>;
  readonly waitForConnection: (total?: number) => Effect.Effect<void, HttpRequestError>;
}

export const HttpTag = Context.GenericTag<HttpLayer>('@layer/HttpLayer');

const gotInstance: Got = got.bind(got);
const userAgent = new UserAgent({ deviceCategory: 'desktop' });

export const isErrorTimeout = (error: unknown): boolean =>
  isErrorLike<{ _tag: string }>(error) && (error._tag === 'TimeoutException' || error.code === 'ETIMEDOUT');

const requestFn = <T = string>(options: string | DefaultOptions): Effect.Effect<Response<T>, HttpRequestError> => {
  const isString = typeof options === 'string';
  const payload = defaultsDeep({}, isString ? { url: options } : options, {
    headers: { 'user-agent': userAgent.toString() },
    http2: true,
  });

  const retryCount = isString ? 3 : (options.retry ?? 3);
  const { initial = 10_000, transmission = 30_000, total = 60_000 } = payload.timeout || {};

  return Effect.tryPromise({
    try: (signal) => {
      const promise = gotInstance({
        ...payload,
        retry: 0,
        timeout: {
          lookup: initial,
          connect: initial,
          secureConnect: initial,
          socket: transmission,
          response: transmission,
          send: transmission,
          request: total,
        },
        resolveBodyOnly: false,
      } as Options) as CancelableRequest<Response<T>>;

      signal.addEventListener('abort', () => promise.cancel(), { once: true });

      return promise;
    },
    catch: (error) => {
      const err = error as RequestError;
      return new HttpRequestError({
        message: err.message || 'Request failed',
        code: err.code,
        status: err.response?.statusCode,
        cause: error,
      });
    },
  }).pipe(
    Effect.retry({
      while: (error) => {
        const isNetworkError = !!error.code && ERROR_CODES.includes(error.code);
        const isRetryableStatus = !!error.status && ERROR_STATUS_CODES.includes(error.status);
        return isNetworkError || isRetryableStatus || isErrorTimeout(error);
      },
      schedule: retryCount < 0 ? Schedule.forever : Schedule.recurs(retryCount),
    }),
  );
};

const waitForConnectionFn = (retryMs: number = 10_000): Effect.Effect<void, HttpRequestError> => {
  const checkGoogle = Effect.tryPromise({
    try: () => lookup('google.com'),
    catch: (error) =>
      new HttpRequestError({
        message: 'DNS lookup failed',
        code: 'ENOTFOUND',
        cause: error,
      }),
  });

  const checkApple = requestFn({
    url: 'https://captive.apple.com/hotspot-detect.html',
    headers: { 'user-agent': 'CaptiveNetworkSupport/1.0 wispr' },
    timeout: { total: retryMs },
  });

  // Racing DNS lookups against HTTP requests provides a faster determination of network availability by utilizing the first successful response.
  return Effect.raceAll([checkGoogle, checkApple]).pipe(Effect.retry(Schedule.spaced(`${retryMs} millis`)), Effect.asVoid);
};

export const request = <T = string>(options: string | DefaultOptions) => Effect.flatMap(HttpTag, (service) => service.request<T>(options));

export const waitForConnection = (total?: number) => Effect.flatMap(HttpTag, (service) => service.waitForConnection(total));

export const HttpLayer = Layer.succeed(
  HttpTag,
  HttpTag.of({
    request: requestFn,
    waitForConnection: waitForConnectionFn,
  }),
);
