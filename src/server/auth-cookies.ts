import type { Response, CookieOptions } from 'express';

const LONG_LIVED_COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;

function authCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: LONG_LIVED_COOKIE_MAX_AGE_MS,
    path: '/',
  };
}

function clearCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  };
}

export function setAuthCookies(res: Response, accessToken: string, refreshToken?: string): void {
  res.cookie('yoinko_token', accessToken, authCookieOptions());
  if (refreshToken) {
    res.cookie('yoinko_refresh_token', refreshToken, authCookieOptions());
  }
}

export function clearAuthCookies(res: Response): void {
  const options = clearCookieOptions();
  res.clearCookie('yoinko_token', options);
  res.clearCookie('yoinko_refresh_token', options);
}
