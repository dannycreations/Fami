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
      catch: (error) => new StoreError({ message: `Failed to load store: ${filePath}`, originalError: error }),
    });

    const save = (data: A) =>
      Effect.tryPromise({
        try: async () => {
          const dir = dirname(filePath);
          await mkdir(dir, { recursive: true });
          const tempPath = `${filePath}.tmp`;
          await writeFile(tempPath, JSON.stringify(data));
          await rename(filePath, `${filePath}.bak`).catch(() => {});
          await rename(tempPath, filePath);
        },
        catch: (error) => new StoreError({ message: `Failed to save store: ${filePath}`, originalError: error }),
      });

    const rawData = yield* _(load);
    const validatedData = yield* _(
      decode(rawData),
      Effect.mapError((e) => new StoreError({ message: `Validation failed for store: ${filePath}`, originalError: e })),
    );

    yield* _(Ref.set(dataRef, validatedData));

    const autoSaveLoop = Effect.gen(function* (_) {
      const delay = yield* _(Ref.get(delayRef));
      yield* _(Effect.sleep(`${delay} millis`));

      const isDirty = yield* _(Ref.get(isDirtyRef));
      if (isDirty) {
        const data = yield* _(Ref.get(dataRef));
        yield* _(
          save(data),
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
          yield* _(save(data));
        }
      }).pipe(Effect.catchAllCause(() => Effect.void)),
    };
  });
};
