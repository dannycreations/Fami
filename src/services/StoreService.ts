import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseJsonc } from '@vegapunk/utilities';
import { defaultsDeep } from '@vegapunk/utilities/common';
import { Context, Data, Effect, Layer, Ref, Schedule, Schema, Scope } from 'effect';

const ensureDir = (path: string) => Effect.tryPromise(() => mkdir(dirname(path), { recursive: true }));

export class StoreError extends Data.TaggedError('StoreError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface Store<T> {
  readonly get: Effect.Effect<T>;
  readonly set: (data: Partial<T>) => Effect.Effect<void>;
  readonly update: (f: (data: T) => T) => Effect.Effect<void>;
  readonly setDelay: (delayMs: number) => Effect.Effect<void>;
}

const loadStore = <A>(filePath: string, initialData: A): Effect.Effect<A, StoreError> =>
  Effect.tryPromise(() => readFile(filePath, 'utf-8')).pipe(
    Effect.flatMap((content) => Effect.sync(() => parseJsonc<A>(content))),
    Effect.map((data) => defaultsDeep({}, data, initialData)),
    Effect.catchAll((error) => {
      // Missing files are handled by creating them with the provided initial data.
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return ensureDir(filePath).pipe(
          Effect.flatMap(() => Effect.tryPromise(() => writeFile(filePath, JSON.stringify(initialData)))),
          Effect.as(initialData),
          Effect.mapError((error) => new StoreError({ message: `Failed to initialize store: ${filePath}`, cause: error })),
        );
      }
      return Effect.fail(error instanceof StoreError ? error : new StoreError({ message: `Failed to load store: ${filePath}`, cause: error }));
    }),
  );

const saveStore = <A>(filePath: string, data: A): Effect.Effect<void, StoreError> =>
  Effect.gen(function* () {
    yield* ensureDir(filePath);

    const tempPath = `${filePath}.tmp`;
    const content = JSON.stringify(data);

    yield* Effect.tryPromise(() => writeFile(tempPath, content));
    yield* Effect.tryPromise(() => rename(tempPath, filePath));
  }).pipe(
    Effect.mapError((error) =>
      error instanceof StoreError ? error : new StoreError({ message: `Failed to save store: ${filePath}`, cause: error }),
    ),
  );

export const createStore = <A extends object, I, R>(
  filePath: string,
  schema: Schema.Schema<A, I, R>,
  initialData: A,
  initialDelay: number = 1000,
): Effect.Effect<Store<A>, StoreError, R | Scope.Scope> =>
  Effect.gen(function* () {
    const dataRef = yield* Ref.make(initialData);
    const delayRef = yield* Ref.make(initialDelay);
    const dirtyRef = yield* Ref.make(false);

    const decode = Schema.decodeUnknown(schema);

    const rawData = yield* loadStore(filePath, initialData);
    const validatedData = yield* decode(rawData).pipe(
      Effect.mapError((error) => new StoreError({ message: `Validation failed for store: ${filePath}`, cause: error })),
    );

    yield* Ref.set(dataRef, validatedData);

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

    const autoSaveLoop = Effect.gen(function* () {
      const delay = yield* Ref.get(delayRef);

      // Periodic execution of the save operation ensures that in-memory state is persisted to disk at regular intervals, minimizing potential data loss.
      yield* Effect.sleep(`${Math.max(1000, delay)} millis`);
      yield* save;
    }).pipe(Effect.repeat(Schedule.forever));

    yield* Effect.fork(autoSaveLoop);

    // Closing the scope triggers a final save operation to ensure data persistence.
    yield* Effect.addFinalizer(() => save.pipe(Effect.catchAllCause(() => Effect.void)));

    return {
      get: Ref.get(dataRef),
      set: (partial) => Ref.update(dataRef, (current) => ({ ...current, ...partial })).pipe(Effect.zipRight(Ref.set(dirtyRef, true))),
      update: (f) => Ref.update(dataRef, f).pipe(Effect.zipRight(Ref.set(dirtyRef, true))),
      setDelay: (delayMs) => Ref.set(delayRef, Math.max(1000, delayMs)),
    };
  });

export const StoreLayer = <S, A extends object, I, R>(
  tag: Context.Tag<S, Store<A>>,
  filePath: string,
  schema: Schema.Schema<A, I, R>,
  initialData: A,
  initialDelay: number = 1000,
): Layer.Layer<S, StoreError, R> => Layer.scoped(tag, createStore(filePath, schema, initialData, initialDelay));
