import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname } from 'node:path';
import { parseJsonc } from '@vegapunk/utilities';
import { defaultsDeep } from '@vegapunk/utilities/common';
import { Context, Data, Effect, Fiber, Layer, Ref, Schedule, Schema, Scope } from 'effect';

export class StoreError extends Data.TaggedError('StoreError')<{
  readonly message: string;
  readonly store?: unknown;
}> {}

export interface Store<T> {
  readonly get: Effect.Effect<T>;
  readonly set: (data: Partial<T>) => Effect.Effect<void>;
  readonly update: (f: (data: T) => T) => Effect.Effect<void>;
  readonly setDelay: (delayMs: number) => Effect.Effect<void>;
}

const loadStore = <A>(filePath: string, initialData: A): Effect.Effect<A, StoreError> =>
  Effect.tryPromise({
    try: () => readFile(filePath, 'utf-8'),
    catch: (error) => error,
  }).pipe(
    Effect.flatMap((content) => Effect.sync(() => parseJsonc<A>(content))),
    Effect.map((data) => defaultsDeep({}, data, initialData)),
    Effect.catchAll((error) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return Effect.tryPromise(() => mkdir(dirname(filePath), { recursive: true })).pipe(
          Effect.flatMap(() => Effect.tryPromise(() => writeFile(filePath, JSON.stringify(initialData)))),
          Effect.as(initialData),
          Effect.mapError((error) => new StoreError({ message: `Failed to initialize store: ${filePath}`, store: error })),
        );
      }
      return Effect.fail(error instanceof StoreError ? error : new StoreError({ message: `Failed to load store: ${filePath}`, store: error }));
    }),
  );

const saveStore = <A>(filePath: string, data: A): Effect.Effect<void, StoreError> =>
  Effect.gen(function* (_) {
    const dir = dirname(filePath);
    yield* _(Effect.tryPromise(() => mkdir(dir, { recursive: true })));

    const tempPath = `${filePath}.tmp`;
    yield* _(Effect.tryPromise(() => writeFile(tempPath, JSON.stringify(data))));

    yield* _(Effect.tryPromise(() => rename(tempPath, filePath)));
  }).pipe(
    Effect.mapError((error) =>
      error instanceof StoreError ? error : new StoreError({ message: `Failed to save store: ${filePath}`, store: error }),
    ),
  );

const makeStore = <A extends object, I, R>(
  filePath: string,
  schema: Schema.Schema<A, I, R>,
  initialData: A,
  initialDelay: number = 1000,
): Effect.Effect<Store<A>, StoreError, R | Scope.Scope> => {
  return Effect.gen(function* (_) {
    const dataRef = yield* _(Ref.make(initialData));
    const delayRef = yield* _(Ref.make(initialDelay));
    const dirtyRef = yield* _(Ref.make(false));

    const decode = Schema.decodeUnknown(schema);

    const rawData = yield* _(loadStore(filePath, initialData));
    const validatedData = yield* _(
      decode(rawData),
      Effect.mapError((error) => new StoreError({ message: `Validation failed for store: ${filePath}`, store: error })),
    );

    yield* _(Ref.set(dataRef, validatedData));

    const save = Effect.gen(function* (_) {
      const isDirty = yield* _(Ref.get(dirtyRef));
      if (!isDirty) return;

      const data = yield* _(Ref.get(dataRef));
      yield* _(
        saveStore(filePath, data),
        Effect.zipRight(Ref.set(dirtyRef, false)),
        Effect.catchAll((error) => Effect.logError(`Store auto-save failed for ${filePath}`, error)),
      );
    });

    const autoSaveLoop = Effect.gen(function* (_) {
      const delay = yield* _(Ref.get(delayRef));
      yield* _(save);
      yield* _(Effect.sleep(`${Math.max(1000, delay)} millis`));
    }).pipe(Effect.repeat(Schedule.forever));

    const autoSaveFiber = yield* _(Effect.forkDaemon(autoSaveLoop));

    // Handle lifecycle using finalizer
    yield* _(
      Effect.addFinalizer(() =>
        Effect.gen(function* (_) {
          yield* _(Fiber.interrupt(autoSaveFiber));
          yield* _(save);
        }).pipe(Effect.catchAllCause(() => Effect.void)),
      ),
    );

    return {
      get: Ref.get(dataRef),
      set: (partial) => Ref.update(dataRef, (current) => ({ ...current, ...partial })).pipe(Effect.zipRight(Ref.set(dirtyRef, true))),
      update: (f) => Ref.update(dataRef, f).pipe(Effect.zipRight(Ref.set(dirtyRef, true))),
      setDelay: (delayMs) => Ref.set(delayRef, Math.max(1000, delayMs)),
    };
  });
};

export const StoreService = <A extends object, I, R>(
  tag: Context.Tag<Store<A>, Store<A>>,
  filePath: string,
  schema: Schema.Schema<A, I, R>,
  initialData: A,
  initialDelay: number = 1000,
) => Layer.scoped(tag, makeStore(filePath, schema, initialData, initialDelay));
