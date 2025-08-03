import { type RequiredExcept } from '@vegapunk/utilities';
import { defaultsDeep } from '@vegapunk/utilities/common';

export abstract class DataStore<T extends object> {
  public static readonly MIN_DELAY: number = 1000;
  public static readonly MAX_DELAY: number = 2147483647;

  public readonly options: RequiredExcept<DataStoreOptions<T>, 'watch'>;
  public readonly data: DataStoreInternalData<T>;

  public constructor(options: DataStoreOptions<T>) {
    this.options = {
      ...options,
      init: options.init ?? ({} as T),
      delay: options.delay ?? DataStore.MIN_DELAY,
      readonly: options.readonly ?? false,
      watch: options.watch ?? undefined,
    };

    this.data = { ...(this.options.init as T), __updatedAt: 0 };
    this.previousData = JSON.stringify(this.data);
    this.isDisposed = false;

    this.delayMs = DataStore.MIN_DELAY;
    this.setDelay(this.options.delay);
    if (typeof this.options.watch === 'function') {
      this.watch();
    }
  }

  public abstract readonly dir: string;
  protected abstract _init(): Promise<void>;
  protected abstract _readFile(): Promise<T | null>;
  protected abstract _writeFile(): Promise<void>;

  public setDelay(delayMs: number = DataStore.MIN_DELAY): void {
    if (this.isDisposed) {
      return;
    }
    this.delayMs = Math.min(Math.max(Math.trunc(delayMs), DataStore.MIN_DELAY), DataStore.MAX_DELAY);
  }

  public async readFile(): Promise<void> {
    if (this.isDisposed) {
      return;
    }
    await this.ensureInit();

    const fileData = (await this._readFile()) ?? ({} as T);
    Object.assign(this.data, defaultsDeep({}, fileData, this.data, this.options.init));
  }

  public async writeFile(data: Partial<T> = this.data, force: boolean = false): Promise<void> {
    if (this.isDisposed) {
      return;
    }
    await this.ensureInit();

    Object.assign(this.data, defaultsDeep({}, data, this.data));
    if (!force && this.options.readonly) {
      return;
    }

    const currentTimeMs = Date.now();
    const isWaiting = this.data.__updatedAt + this.delayMs > currentTimeMs;
    if (!force && isWaiting) {
      return;
    }

    const currentData = JSON.stringify(this.data);
    const isUnchanged = currentData === this.previousData;
    if (!force && isWaiting && isUnchanged) {
      return;
    }

    this.data.__updatedAt = currentTimeMs;
    await this._writeFile();
    this.previousData = JSON.stringify(this.data);
  }

  public clear(force: boolean = false): void {
    if (this.isDisposed || (!force && this.options.readonly)) {
      return;
    }

    Object.assign(this, {
      data: {
        ...this.options.init,
        __updatedAt: 0,
      },
    });
    this.previousData = JSON.stringify(this.data);
  }

  public dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this.isDisposed = true;
    clearTimeout(this.watchTimeoutId);
    this.watchTimeoutId = undefined;
  }

  private watchTimeoutId?: NodeJS.Timeout;
  private watch(): void {
    clearTimeout(this.watchTimeoutId);
    this.watchTimeoutId = undefined;
    if (this.isDisposed || typeof this.options.watch !== 'function') {
      return;
    }

    this.watchTimeoutId = setTimeout(async () => {
      try {
        if (typeof this.options.watch !== 'function') {
          return;
        }

        const promises = Promise.resolve(this.options.watch());
        await this.writeFile(await promises);
      } finally {
        this.watch();
      }
    }, this.delayMs);
  }

  private initPromise?: Promise<void>;
  private async ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        try {
          await this._init();
        } catch (error) {
          this.initPromise = undefined;
          throw error;
        }
      })();
    }
    return this.initPromise;
  }

  private delayMs: number;
  private isDisposed: boolean;
  private previousData: string;
}

type DataStoreInternalData<T extends object> = T & {
  __updatedAt: number;
};

export interface DataStoreOptions<T extends object> {
  readonly init?: Partial<T>;
  readonly delay?: number;
  readonly readonly?: boolean;
  readonly watch?: () => T | Promise<T>;
}
