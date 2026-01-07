import { readFile, rename, writeFile } from 'node:fs/promises';
import { parseJsonc } from '@vegapunk/utilities';
import { defaultsDeep } from '@vegapunk/utilities/common';
import { Context, Data, Effect, Fiber, Layer, Ref, Schedule, Schema, Scope } from 'effect';

import { ensureDir } from '../core/utils';

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
        return ensureDir(filePath).pipe(
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
    yield* _(ensureDir(filePath));

    const tempPath = `${filePath}.tmp`;
    yield* _(Effect.tryPromise(() => writeFile(tempPath, JSON.stringify(data))));

    yield* _(Effect.tryPromise(() => rename(tempPath, filePath)));
  }).pipe(
    Effect.mapError((error) =>
      error instanceof StoreError ? error : new StoreError({ message: `Failed to save store: ${filePath}`, store: error }),
    ),
  );

const createStore = <A extends object, I, R>(
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

    const save = Ref.getAndSet(dirtyRef, false).pipe(
      Effect.flatMap((isDirty) =>
        isDirty
          ? Ref.get(dataRef).pipe(
              Effect.flatMap((data) => saveStore(filePath, data)),
              Effect.catchAll((error) => Effect.zipRight(Ref.set(dirtyRef, true), Effect.logError(`Store auto-save failed for ${filePath}`, error))),
            )
          : Effect.void,
      ),
    );

    const autoSaveLoop = Effect.gen(function* (_) {
      const delay = yield* _(Ref.get(delayRef));
      yield* _(Effect.sleep(`${Math.max(1000, delay)} millis`));
      yield* _(save);
    }).pipe(Effect.repeat(Schedule.forever));

    const autoSaveFiber = yield* _(Effect.forkDaemon(autoSaveLoop));

    yield* _(Effect.addFinalizer(() => Effect.zipRight(Fiber.interrupt(autoSaveFiber), save).pipe(Effect.catchAllCause(() => Effect.void))));

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
): Layer.Layer<Store<A>, StoreError, R> => Layer.scoped(tag, createStore(filePath, schema, initialData, initialDelay));
