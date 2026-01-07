import { lookup } from 'node:dns/promises';
import { defaultsDeep } from '@vegapunk/utilities/common';
import { Context, Data, Effect, Layer, Schedule } from 'effect';
import got from 'got';
import UserAgent from 'user-agents';

import type { CancelableRequest, Got, Options, RequestError, Response } from 'got';

export class HttpRequestError extends Data.TaggedError('HttpRequestError')<{
  readonly message: string;
  readonly code?: string;
  readonly status?: number;
  readonly request?: unknown;
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

export interface HttpService {
  readonly request: <T = string>(options: string | DefaultOptions) => Effect.Effect<Response<T>, HttpRequestError>;
  readonly waitForConnection: (total?: number) => Effect.Effect<void, HttpRequestError>;
}

const gotInstance: Got = got.bind(got);
const userAgent = new UserAgent({ deviceCategory: 'desktop' });
const HttpClient = Context.GenericTag<HttpService>('@services/HttpClient');

const requestImpl = <T = string>(options: string | DefaultOptions): Effect.Effect<Response<T>, HttpRequestError> => {
  const payload = defaultsDeep(
    {},
    {
      url: typeof options === 'string' ? options : undefined,
      ...(typeof options === 'object' ? options : {}),
    },
    {
      headers: { 'user-agent': userAgent.toString() },
      http2: true,
    },
  );

  const retryCount = typeof options === 'object' ? (options.retry ?? 3) : 3;
  const { initial = 10_000, transmission = 30_000, total = 60_000 } = payload.timeout || {};

  const performRequest = Effect.async<Response<T>, HttpRequestError>((resume) => {
    const instance = gotInstance({
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
    } satisfies Options) as CancelableRequest<Response<T>>;

    instance
      .then((res) => resume(Effect.succeed(res)))
      .catch((error) =>
        resume(
          Effect.fail(
            new HttpRequestError({
              message: error.message || 'Request failed',
              code: (error as RequestError).code,
              status: (error as RequestError).response?.statusCode,
              request: error,
            }),
          ),
        ),
      );
    return Effect.sync(() => instance.cancel());
  });

  return performRequest.pipe(
    Effect.retry(
      Schedule.intersect(
        Schedule.recurWhile((error: HttpRequestError) => {
          const isNetworkError = error.code ? ERROR_CODES.includes(error.code) : false;
          const isRetryableStatus = error.status ? ERROR_STATUS_CODES.includes(error.status) : false;
          return isNetworkError || isRetryableStatus;
        }),
        retryCount < 0 ? Schedule.forever : Schedule.recurs(retryCount),
      ),
    ),
  );
};

const waitForConnectionImpl = (retryMs: number = 10_000): Effect.Effect<void, HttpRequestError> => {
  const checkGoogle = Effect.tryPromise({
    try: () => lookup('google.com'),
    catch: (error) =>
      new HttpRequestError({
        message: 'DNS lookup failed',
        code: 'ENOTFOUND',
        request: error,
      }),
  });

  const checkApple = requestImpl({
    url: 'https://captive.apple.com/hotspot-detect.html',
    headers: { 'user-agent': 'CaptiveNetworkSupport/1.0 wispr' },
    timeout: { total: retryMs },
  });

  return Effect.race(checkGoogle, checkApple).pipe(Effect.retry(Schedule.spaced(`${retryMs} millis`)), Effect.asVoid);
};

export const request = <T = string>(options: string | DefaultOptions) => Effect.flatMap(HttpClient, (service) => service.request<T>(options));

export const waitForConnection = (total?: number) => Effect.flatMap(HttpClient, (service) => service.waitForConnection(total));

export const HttpService = Layer.succeed(
  HttpClient,
  HttpClient.of({
    request: requestImpl,
    waitForConnection: waitForConnectionImpl,
  }),
);
