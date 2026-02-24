import { lookup } from 'node:dns/promises';
import { isErrorLike } from '@vegapunk/utilities/result';
import { Context, Data, Effect, Layer, Schedule } from 'effect';
import got from 'got';
import UserAgent from 'user-agents';

import type { CancelableRequest, Got, Options, Response } from 'got';

export class HttpClientError extends Data.TaggedError('HttpClientError')<{
  readonly message: string;
  readonly code?: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

export const ERROR_CODES: ReadonlySet<string> = new Set([
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
]);

export const ERROR_STATUS_CODES: ReadonlySet<number> = new Set([408, 413, 429, 500, 502, 503, 504, 521, 522, 524]);

export interface DefaultOptions extends Omit<Options, 'prefixUrl' | 'retry' | 'timeout' | 'resolveBodyOnly'> {
  readonly retry?: number;
  readonly timeout?: Partial<{
    readonly initial: number;
    readonly transmission: number;
    readonly total: number;
  }>;
}

export interface HttpClient {
  readonly request: <T = string>(options: string | DefaultOptions) => Effect.Effect<Response<T>, HttpClientError>;
  readonly waitForConnection: (total?: number) => Effect.Effect<void>;
}

export class HttpClientTag extends Context.Tag('@structures/HttpClient')<HttpClientTag, HttpClient>() {}

export const isTimeoutError = (error: unknown): boolean =>
  isErrorLike<{ readonly _tag: string; readonly code?: string; readonly message?: string }>(error) &&
  (error._tag === 'TimeoutException' ||
    error.code === 'ETIMEDOUT' ||
    (typeof error.message === 'string' && error.message.toLowerCase().includes('timeout')));

export const isNetworkError = (error: unknown): boolean => {
  const isError = isErrorLike<{ readonly status?: number; readonly code?: string }>(error);
  if (!isError) return false;
  const isNetwork = typeof error.code === 'string' && ERROR_CODES.has(error.code);
  const isRetryableStatus = typeof error.status === 'number' && ERROR_STATUS_CODES.has(error.status);
  return isNetwork || isRetryableStatus || isTimeoutError(error);
};

export const request = <T = string>(options: string | DefaultOptions): Effect.Effect<Response<T>, HttpClientError, HttpClientTag> =>
  Effect.flatMap(HttpClientTag, (service) => service.request<T>(options));

export const waitForConnection = (total?: number): Effect.Effect<void, never, HttpClientTag> =>
  Effect.flatMap(HttpClientTag, (service) => service.waitForConnection(total));

const makeHttpClient = Effect.gen(function* () {
  const gotInstance: Got = got.bind(got);
  const userAgent = new UserAgent({ deviceCategory: 'desktop' }).toString();

  const requestFn = <T = string>(options: string | DefaultOptions): Effect.Effect<Response<T>, HttpClientError> =>
    Effect.gen(function* () {
      const isString = typeof options === 'string';
      const payload: DefaultOptions = isString ? { url: options } : options;

      const headers = { 'user-agent': userAgent, ...payload.headers };
      const retryCount = isString ? 3 : (payload.retry ?? 3);
      const { initial = 10_000, transmission = 30_000, total = 60_000 } = payload.timeout || {};

      const response = yield* Effect.async<Response<T>, HttpClientError>((resume) => {
        const promise = gotInstance({
          ...payload,
          headers,
          http2: true,
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
        }) as CancelableRequest<Response<T>>;

        promise
          .then((response) => resume(Effect.succeed(response)))
          .catch((cause) =>
            resume(
              Effect.fail(
                new HttpClientError({
                  message: cause.message || 'Request failed',
                  code: cause.code,
                  status: cause.response?.statusCode,
                  cause,
                }),
              ),
            ),
          );

        return Effect.sync(() => {
          promise.cancel();
        });
      }).pipe(
        Effect.retry({
          while: isNetworkError,
          schedule: retryCount < 0 ? Schedule.forever : Schedule.recurs(retryCount),
        }),
      );

      return response;
    });

  const waitForConnectionFn = (total?: number): Effect.Effect<void> =>
    Effect.gen(function* () {
      const retryMs = total ?? 10_000;

      const checkGoogle = Effect.promise(() => lookup('google.com'));

      const checkApple = requestFn({
        url: 'https://captive.apple.com/hotspot-detect.html',
        headers: { 'user-agent': 'CaptiveNetworkSupport/1.0 wispr' },
        timeout: { total: retryMs },
      });

      yield* Effect.firstSuccessOf([checkGoogle, checkApple]).pipe(
        Effect.sandbox,
        Effect.retry(Schedule.spaced(`${retryMs} millis`)),
        Effect.catchAll(() => Effect.void),
      );
    });

  return {
    request: requestFn,
    waitForConnection: waitForConnectionFn,
  } satisfies HttpClient;
});

export const HttpClientLayer: Layer.Layer<HttpClientTag> = Layer.effect(HttpClientTag, makeHttpClient);
