import SteamUser from 'steam-user';

export const TIMEOUT_MESSAGE = 'Request timed out';

export const DEFAULT_SLEEP_DURATION = '10 seconds';

export const RATE_LIMIT_MIN_MS = 1_800_000;

export const USER_OFFLINE_STATE = [SteamUser.EPersonaState.Offline, SteamUser.EPersonaState.Invisible] as const;
