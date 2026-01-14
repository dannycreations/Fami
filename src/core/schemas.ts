import { Context, Effect, Schema } from 'effect';

import type { StoreClient } from '../structures/StoreClient';

export class RegistrationSemaphore extends Context.Tag('RegistrationSemaphore')<RegistrationSemaphore, Effect.Semaphore>() {}

export const GameContext = Schema.Struct({
  name: Schema.String,
  appId: Schema.Number,
});
export type GameContext = Schema.Schema.Type<typeof GameContext>;

export const PreferenceSchema = Schema.Struct({
  fetchFreeGames: Schema.optional(Schema.Boolean),
  whitelistGameIds: Schema.optional(Schema.Array(Schema.Number)),
  blacklistGameIds: Schema.optional(Schema.Array(Schema.Number)),
  family: Schema.optional(Schema.Array(Schema.String)),
});
export type PreferenceSchema = Schema.Schema.Type<typeof PreferenceSchema>;

export const UserContext = Schema.Struct({
  id: Schema.optional(Schema.String),
  username: Schema.String,
  password: Schema.optional(Schema.String),
  secret: Schema.optional(Schema.String),
  refreshToken: Schema.optional(Schema.String),
  ...PreferenceSchema.fields,
});
export type UserContext = Schema.Schema.Type<typeof UserContext>;

export const ConfigContext = Schema.Struct({
  refreshGames: Schema.Number,
  skipBannedGames: Schema.Boolean,
  ...PreferenceSchema.fields,
  users: Schema.Array(UserContext),
});
export type ConfigContext = Schema.Schema.Type<typeof ConfigContext>;

export const INITIAL_CONFIG: ConfigContext = {
  refreshGames: 3_600_000,
  fetchFreeGames: false,
  skipBannedGames: true,
  whitelistGameIds: [],
  blacklistGameIds: [],
  family: [],
  users: [],
};

export const ConfigStoreTag = Context.GenericTag<StoreClient<ConfigContext>>('@schemas/ConfigStore');

export const SessionContext = Schema.Struct({
  lastLoop: Schema.Number,
  lastPage: Schema.Number,
  freeGameIds: Schema.Array(Schema.Number),
  freeGameList: Schema.Array(GameContext),
  forceRegister: Schema.Boolean,
  ownedGameList: Schema.Array(GameContext),
  bannedGameIds: Schema.Array(Schema.Number),
});
export type SessionContext = Schema.Schema.Type<typeof SessionContext>;

export const INITIAL_SESSION: SessionContext = {
  lastLoop: 0,
  lastPage: 1,
  freeGameIds: [],
  freeGameList: [],
  forceRegister: false,
  ownedGameList: [],
  bannedGameIds: [],
};

export const SessionStore = Context.GenericTag<StoreClient<SessionContext>>('@schemas/SessionStore');

export const UserStatus = Schema.Struct({
  persona_state: Schema.NullOr(Schema.Number),
  player_name: Schema.NullOr(Schema.String),
});
export type UserStatus = Schema.Schema.Type<typeof UserStatus>;
