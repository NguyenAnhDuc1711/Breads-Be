import { Constants } from "../Breads-Shared/Constants/index.js";

export const RESTRICTED_USER_STATUSES: number[] = [
  Constants.USER_STATUS.LOCK,
  Constants.USER_STATUS.BANNED,
];

export const isAccountRestricted = (status: unknown): boolean => {
  const value = Number(status);
  if (!Number.isFinite(value)) return false;
  return RESTRICTED_USER_STATUSES.includes(value);
};

export const ACCOUNT_RESTRICTED_CODE = "ACCOUNT_RESTRICTED";
