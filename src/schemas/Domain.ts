import { Schema } from 'effect';

export const GameContext = Schema.Struct({
  name: Schema.String,
  appid: Schema.Number,
});
export type GameContext = Schema.Schema.Type<typeof GameContext>;

export const UserContext = Schema.Struct({
  id: Schema.optional(Schema.String),
  username: Schema.String,
  password: Schema.String,
  secret: Schema.optional(Schema.String),
  family: Schema.optional(Schema.Array(Schema.String)),
  fetchFreeGames: Schema.optional(Schema.Boolean),
  whitelistGameIds: Schema.optional(Schema.Array(Schema.Number)),
  blacklistGameIds: Schema.optional(Schema.Array(Schema.Number)),
  refreshToken: Schema.optional(Schema.String),
});
export type UserContext = Schema.Schema.Type<typeof UserContext>;

export const ConfigContext = Schema.Struct({
  refreshGames: Schema.Number,
  fetchFreeGames: Schema.Boolean,
  skipBannedGames: Schema.Boolean,
  whitelistGameIds: Schema.Array(Schema.Number),
  blacklistGameIds: Schema.Array(Schema.Number),
  family: Schema.Array(Schema.String),
  users: Schema.Array(UserContext),
});
export type ConfigContext = Schema.Schema.Type<typeof ConfigContext>;

export const SessionData = Schema.Struct({
  lastLoop: Schema.Number,
  lastPage: Schema.Number,
  freeGameIds: Schema.Array(Schema.Number),
  freeGameList: Schema.Array(GameContext),
  freeGameLength: Schema.Number,
  forceRegister: Schema.Boolean,
  ownedGameList: Schema.Array(GameContext),
  bannedGameIds: Schema.Array(Schema.Number),
});
export type SessionData = Schema.Schema.Type<typeof SessionData>;

export const UserStatus = Schema.Struct({
  persona_state: Schema.NullOr(Schema.Number),
  player_name: Schema.NullOr(Schema.String),
});
export type UserStatus = Schema.Schema.Type<typeof UserStatus>;

export const SessionState = Schema.Struct({
  logged: Schema.Boolean,
  enabled: Schema.Boolean,
  playing: Schema.Boolean,
});
export type SessionState = Schema.Schema.Type<typeof SessionState>;
