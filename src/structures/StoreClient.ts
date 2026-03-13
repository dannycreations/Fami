import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseJsonc } from '@vegapunk/utilities';
import { defaultsDeep } from '@vegapunk/utilities/common';
import { isErrorLike } from '@vegapunk/utilities/result';
import { Context, Data, Effect, Layer, Ref, Schedule, Schema, Scope } from 'effect';

const ensureDir = (path: string): Effect.Effect<void, StoreClientError> =>
  Effect.tryPromise({
    try: () => mkdir(dirname(path), { recursive: true }),
    catch: (cause) => new StoreClientError({ message: `Failed to ensure directory: ${dirname(path)}`, cause }),
  });

export class StoreClientError extends Data.TaggedError('StoreClientError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface StoreClient<in out T> {
  readonly get: Effect.Effect<T>;
  readonly set: (data: Partial<T>) => Effect.Effect<void>;
  readonly update: (f: (data: T) => T) => Effect.Effect<void>;
  readonly setDelay: (delayMs: number) => Effect.Effect<void>;
}

const loadStore = (filePath: string): Effect.Effect<unknown, StoreClientError> =>
  Effect.tryPromise({
    try: () => readFile(filePath, 'utf-8'),
    catch: (error) => error,
  }).pipe(
    Effect.flatMap((content) =>
      Effect.try({
        try: () => parseJsonc<unknown>(content),
        catch: (cause) => new StoreClientError({ message: `Failed to parse store: ${filePath}`, cause }),
      }),
    ),
    Effect.catchAll((cause) => {
      const isNotFound = isErrorLike<{ readonly code: string }>(cause) && cause.code === 'ENOENT';
      if (isNotFound) {
        return Effect.succeed({});
      }

      if (cause instanceof StoreClientError) {
        return Effect.fail(cause);
      }

      const error = new StoreClientError({ message: `Failed to load store: ${filePath}`, cause });
      return Effect.fail(error);
    }),
  );

const saveStore = <A, I, R>(filePath: string, schema: Schema.Schema<A, I, R>, data: A): Effect.Effect<void, StoreClientError, R> =>
  Effect.gen(function* () {
    yield* ensureDir(filePath);

    const encode = Schema.encode(schema);
    const encoded = yield* encode(data).pipe(
      Effect.mapError((cause) => new StoreClientError({ message: `Failed to encode store: ${filePath}`, cause })),
    );

    const tempPath = `${filePath}.tmp`;
    const content = JSON.stringify(encoded);

    yield* Effect.tryPromise({
      try: () => writeFile(tempPath, content),
      catch: (cause) => new StoreClientError({ message: `Failed to write temp store: ${tempPath}`, cause }),
    });

    yield* Effect.tryPromise({
      try: () => rename(tempPath, filePath),
      catch: (cause) => new StoreClientError({ message: `Failed to rename store: ${tempPath} -> ${filePath}`, cause }),
    });
  });

export const makeStoreClient = <A extends object, I, R>(
  filePath: string,
  schema: Schema.Schema<A, I, R>,
  initialData: A,
  initialDelay = 1000,
): Effect.Effect<StoreClient<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const dataRef = yield* Ref.make(initialData);
    const delayRef = yield* Ref.make(initialDelay);
    const dirtyRef = yield* Ref.make(false);

    const decode = Schema.decodeUnknown(schema);

    const rawData = yield* loadStore(filePath).pipe(Effect.catchAll(() => Effect.succeed({})));
    const validatedData = yield* decode(rawData).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning(`Store validation failed for ${filePath}, merging with defaults`);
          yield* Effect.logDebug(error);

          const partialDecode = Schema.decodeUnknown(Schema.partial(schema));
          const partial = yield* partialDecode(rawData).pipe(Effect.catchAll(() => Effect.succeed({})));

          const merged = defaultsDeep<A>({}, partial, initialData);
          return Data.struct(merged);
        }),
      ),
    );

    yield* Ref.set(dataRef, validatedData);

    const save = Effect.gen(function* () {
      const isDirty = yield* Ref.getAndSet(dirtyRef, false);

      if (!isDirty) {
        return;
      }

      const data = yield* Ref.get(dataRef);
      const saveResult = yield* saveStore(filePath, schema, data).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            yield* Ref.set(dirtyRef, true);
            yield* Effect.logError(`Store auto-save failed for ${filePath}`, error);
          }),
        ),
      );

      return saveResult;
    });

    yield* Effect.forkScoped(
      Effect.gen(function* () {
        const delay = yield* Ref.get(delayRef);
        yield* Effect.sleep(`${Math.max(1000, delay)} millis`);
        yield* save;
      }).pipe(Effect.repeat(Schedule.forever)),
    );

    yield* Effect.addFinalizer(() => save.pipe(Effect.ignore));

    return {
      get: Ref.get(dataRef),
      set: (partial) =>
        Effect.gen(function* () {
          yield* Ref.update(dataRef, (current) => ({ ...current, ...partial }));
          yield* Ref.set(dirtyRef, true);
        }),
      update: (f) =>
        Effect.gen(function* () {
          yield* Ref.update(dataRef, f);
          yield* Ref.set(dirtyRef, true);
        }),
      setDelay: (delayMs) => Ref.set(delayRef, Math.max(1000, delayMs)),
    } satisfies StoreClient<A>;
  });

export const StoreClientLayer = <I, S extends StoreClient<A>, A extends object, IS, R>(
  tag: Context.Tag<I, S>,
  filePath: string,
  schema: Schema.Schema<A, IS, R>,
  initialData: A,
  initialDelay = 1000,
): Layer.Layer<I, never, Scope.Scope | R> =>
  Layer.scoped(tag, makeStoreClient(filePath, schema, initialData, initialDelay).pipe(Effect.map((client) => client as unknown as S)));
