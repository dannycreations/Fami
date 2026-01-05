import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname } from 'node:path';
import { parseJsonc } from '@vegapunk/utilities';
import { defaultsDeep } from '@vegapunk/utilities/common';
import { Effect, Fiber, Ref, Schema } from 'effect';

export class StoreError extends Error {
  readonly _tag = 'StoreError';
  constructor(
    override readonly message: string,
    readonly originalError?: unknown,
  ) {
    super(message);
  }
}

export interface Store<T> {
  readonly get: Effect.Effect<T>;
  readonly set: (data: Partial<T>) => Effect.Effect<void>;
  readonly update: (f: (data: T) => T) => Effect.Effect<void>;
  readonly setDelay: (delayMs: number) => Effect.Effect<void>;
  readonly dispose: Effect.Effect<void>;
}

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

    const load = Effect.tryPromise({
      try: async () => {
        try {
          const content = await readFile(filePath, 'utf-8');
          const data = parseJsonc<A>(content);
          return defaultsDeep({}, data, initialData);
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            const dir = dirname(filePath);
            await mkdir(dir, { recursive: true });
            await writeFile(filePath, JSON.stringify(initialData));
            return initialData;
          }
          throw error;
        }
      },
      catch: (error) => new StoreError(`Failed to load store: ${filePath}`, error),
    });

    const save = (data: A) =>
      Effect.tryPromise({
        try: async () => {
          const dir = dirname(filePath);
          await mkdir(dir, { recursive: true });
          const tempPath = `${filePath}.tmp`;
          await writeFile(tempPath, JSON.stringify(data));
          await rename(filePath, `${filePath}.bak`).catch(Boolean);
          await rename(tempPath, filePath);
        },
        catch: (error) => new StoreError(`Failed to save store: ${filePath}`, error),
      });

    const rawData = yield* _(load);
    const validatedData = yield* _(
      decode(rawData),
      Effect.mapError((e) => new StoreError(`Validation failed for store: ${filePath}`, e)),
    );

    yield* _(Ref.set(dataRef, validatedData));

    const autoSaveLoop = Effect.gen(function* (_) {
      while (true) {
        const delay = yield* _(Ref.get(delayRef));
        yield* _(Effect.sleep(`${delay} millis`));

        const isDirty = yield* _(Ref.get(isDirtyRef));
        if (isDirty) {
          const data = yield* _(Ref.get(dataRef));
          yield* _(save(data));
          yield* _(Ref.set(isDirtyRef, false));
        }
      }
    }).pipe(Effect.catchAll((error) => Effect.logError('Store auto-save failed', error)));

    const autoSaveFiber = yield* _(Effect.forkDaemon(autoSaveLoop));

    return {
      get: Ref.get(dataRef),
      set: (partial: Partial<A>) =>
        Effect.gen(function* (_) {
          yield* _(Ref.update(dataRef, (current) => ({ ...current, ...partial })));
          yield* _(Ref.set(isDirtyRef, true));
        }),
      update: (f: (data: A) => A) =>
        Effect.gen(function* (_) {
          yield* _(Ref.update(dataRef, f));
          yield* _(Ref.set(isDirtyRef, true));
        }),
      setDelay: (delayMs: number) => Ref.set(delayRef, Math.max(1000, delayMs)),
      dispose: Effect.gen(function* (_) {
        yield* _(Fiber.interrupt(autoSaveFiber));
        const isDirty = yield* _(Ref.get(isDirtyRef));
        if (isDirty) {
          const data = yield* _(Ref.get(dataRef));
          yield* _(save(data));
        }
      }).pipe(Effect.catchAllCause(() => Effect.void)),
    };
  });
};
