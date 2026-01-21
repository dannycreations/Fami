import { lookup } from 'node:dns/promises';
import { defaultsDeep } from '@vegapunk/utilities/common';
import { isErrorLike } from '@vegapunk/utilities/result';
import { Context, Data, Effect, Layer, Schedule } from 'effect';
import got, { RequestError } from 'got';
import UserAgent from 'user-agents';

import type { CancelableRequest, Got, Options, Response } from 'got';

export class HttpClientError extends Data.TaggedError('HttpClientError')<{
  readonly message: string;
  readonly code?: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

export const ERROR_CODES: ReadonlyArray<string> = [
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

export const ERROR_STATUS_CODES: ReadonlyArray<number> = [408, 413, 429, 500, 502, 503, 504, 521, 522, 524];

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

export const isErrorTimeout = (error: unknown): boolean =>
  isErrorLike<{ readonly _tag: string; readonly code?: string }>(error) && (error._tag === 'TimeoutException' || error.code === 'ETIMEDOUT');

export const request = <T = string>(options: string | DefaultOptions): Effect.Effect<Response<T>, HttpClientError, HttpClientTag> =>
  Effect.flatMap(HttpClientTag, (service) => service.request<T>(options));

export const waitForConnection = (total?: number): Effect.Effect<void, never, HttpClientTag> =>
  Effect.flatMap(HttpClientTag, (service) => service.waitForConnection(total));

const makeHttpClient = Effect.gen(function* () {
  const gotInstance: Got = got.bind(got);
  const userAgent = new UserAgent({ deviceCategory: 'desktop' });

  const requestFn = <T = string>(options: string | DefaultOptions): Effect.Effect<Response<T>, HttpClientError> =>
    Effect.gen(function* () {
      const isString = typeof options === 'string';
      const payload: DefaultOptions = defaultsDeep({}, isString ? { url: options } : options, {
        headers: { 'user-agent': userAgent.toString() },
        http2: true,
      });

      const retryCount = isString ? 3 : (options.retry ?? 3);
      const { initial = 10_000, transmission = 30_000, total = 60_000 } = payload.timeout || {};

      return yield* Effect.async<Response<T>, HttpClientError>((resume) => {
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
        }) as CancelableRequest<Response<T>>;

        promise
          .then((response) => resume(Effect.succeed(response)))
          .catch((cause) =>
            resume(
              Effect.fail(
                cause instanceof RequestError
                  ? new HttpClientError({
                      message: cause.message || 'Request failed',
                      code: cause.code,
                      status: cause.response?.statusCode,
                      cause,
                    })
                  : new HttpClientError({
                      message: String(cause),
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
          while: (error) => {
            const isNetworkError = !!error.code && ERROR_CODES.includes(error.code);
            const isRetryableStatus = !!error.status && ERROR_STATUS_CODES.includes(error.status);
            return isNetworkError || isRetryableStatus || isErrorTimeout(error);
          },
          schedule: retryCount < 0 ? Schedule.forever : Schedule.recurs(retryCount),
        }),
      );
    });

  const waitForConnectionFn = (total?: number): Effect.Effect<void> => {
    const retryMs = total ?? 10_000;

    const checkGoogle = Effect.tryPromise({
      try: () => lookup('google.com'),
      catch: (cause) =>
        new HttpClientError({
          message: 'DNS lookup failed',
          cause,
        }),
    }).pipe(Effect.ignore);

    const checkApple = requestFn({
      url: 'https://captive.apple.com/hotspot-detect.html',
      headers: { 'user-agent': 'CaptiveNetworkSupport/1.0 wispr' },
      timeout: { total: retryMs },
    }).pipe(Effect.ignore);

    return Effect.race(checkGoogle, checkApple).pipe(
      Effect.retry(Schedule.intersect(Schedule.forever, Schedule.spaced(`${retryMs} millis`))),
      Effect.ignore,
    );
  };

  return {
    request: requestFn,
    waitForConnection: waitForConnectionFn,
  } satisfies HttpClient;
});

export const HttpClientLayer: Layer.Layer<HttpClientTag> = Layer.effect(HttpClientTag, makeHttpClient);
