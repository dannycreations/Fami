import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname } from 'node:path';
import { parseJsonc } from '@vegapunk/utilities';
import { defaultsDeep } from '@vegapunk/utilities/common';
import { Effect, Fiber, Ref, Schedule, Schema } from 'effect';

import { StoreError } from '../core/errors';

export interface Store<T> {
  readonly get: Effect.Effect<T>;
  readonly set: (data: Partial<T>) => Effect.Effect<void>;
  readonly update: (f: (data: T) => T) => Effect.Effect<void>;
  readonly setDelay: (delayMs: number) => Effect.Effect<void>;
  readonly dispose: Effect.Effect<void>;
}

const loadStore = <A>(filePath: string, initialData: A) =>
  Effect.tryPromise({
    try: () => readFile(filePath, 'utf-8'),
    catch: (error) => error,
  }).pipe(
    Effect.map((content) => parseJsonc<A>(content)),
    Effect.map((data) => defaultsDeep({}, data, initialData)),
    Effect.catchAll((error) =>
      Effect.gen(function* (_) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          const dir = dirname(filePath);
          yield* _(
            Effect.tryPromise({
              try: () => mkdir(dir, { recursive: true }),
              catch: (error) => error,
            }),
          );
          yield* _(
            Effect.tryPromise({
              try: () => writeFile(filePath, JSON.stringify(initialData)),
              catch: (error) => error,
            }),
          );
          return initialData;
        }
        return yield* _(Effect.fail(new StoreError({ message: `Failed to load store: ${filePath}`, originalError: error })));
      }),
    ),
    Effect.catchAll((error) => {
      if (error instanceof StoreError) return Effect.fail(error);
      return Effect.fail(new StoreError({ message: `Failed to load store: ${filePath}`, originalError: error }));
    }),
  );

const saveStore = <A>(filePath: string, data: A) =>
  Effect.gen(function* (_) {
    const dir = dirname(filePath);
    yield* _(
      Effect.tryPromise({
        try: () => mkdir(dir, { recursive: true }),
        catch: (error) => error,
      }),
    );
    const tempPath = `${filePath}.tmp`;
    yield* _(
      Effect.tryPromise({
        try: () => writeFile(tempPath, JSON.stringify(data)),
        catch: (error) => error,
      }),
    );
    yield* _(
      Effect.tryPromise({
        try: () => rename(filePath, `${filePath}.bak`),
        catch: (error) => error,
      }),
      Effect.ignore,
    );
    yield* _(
      Effect.tryPromise({
        try: () => rename(tempPath, filePath),
        catch: (error) => error,
      }),
    );
  }).pipe(
    Effect.mapError((error) => {
      if (error instanceof StoreError) return error;
      return new StoreError({ message: `Failed to save store: ${filePath}`, originalError: error });
    }),
  );

export const makeStore = <A extends object, I, R>(
  filePath: string,
  schema: Schema.Schema<A, I, R>,
  initialData: A,
  initialDelay: number = 1000,
): Effect.Effect<Store<A>, StoreError, R> => {
  return Effect.gen(function* (_) {
    const dataRef = yield* _(Ref.make(initialData));
    const isDirtyRef = yield* _(Ref.make(false));
    const delayRef = yield* _(Ref.make(initialDelay));

    const decode = Schema.decodeUnknown(schema);

    const rawData = yield* _(loadStore(filePath, initialData));
    const validatedData = yield* _(
      decode(rawData),
      Effect.mapError((error) => new StoreError({ message: `Validation failed for store: ${filePath}`, originalError: error })),
    );

    yield* _(Ref.set(dataRef, validatedData));

    const autoSaveLoop = Effect.gen(function* (_) {
      const delay = yield* _(Ref.get(delayRef));
      yield* _(Effect.sleep(`${Math.max(1000, delay)} millis`));

      const isDirty = yield* _(Ref.get(isDirtyRef));
      if (isDirty) {
        const data = yield* _(Ref.get(dataRef));
        yield* _(
          saveStore(filePath, data),
          Effect.tap(() => Ref.set(isDirtyRef, false)),
          Effect.catchAll((error) => Effect.logError(`Store auto-save failed for ${filePath}`, error)),
        );
      }
    }).pipe(Effect.repeat(Schedule.forever));

    const autoSaveFiber = yield* _(Effect.forkDaemon(autoSaveLoop));

    const triggerUpdate = (f: (data: A) => A) =>
      Effect.gen(function* (_) {
        yield* _(Ref.update(dataRef, f));
        yield* _(Ref.set(isDirtyRef, true));
      });

    return {
      get: Ref.get(dataRef),
      set: (partial) => triggerUpdate((current) => ({ ...current, ...partial })),
      update: (f) => triggerUpdate(f),
      setDelay: (delayMs) => Ref.set(delayRef, Math.max(1000, delayMs)),
      dispose: Effect.gen(function* (_) {
        yield* _(Fiber.interrupt(autoSaveFiber));
        const isDirty = yield* _(Ref.get(isDirtyRef));
        if (isDirty) {
          const data = yield* _(Ref.get(dataRef));
          yield* _(saveStore(filePath, data));
        }
      }).pipe(Effect.catchAllCause(() => Effect.void)),
    };
  });
};
