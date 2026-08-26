# Auth Branding Assets

Place approved Autolibre AI authentication visual assets in this directory.

## Expected files

- `auth-background.png` (or `.jpg`) for branded login/sign-up background
- `auth-logo.png` for lockup or mark shown in auth shell (optional)

## Fallback behavior

If local assets are missing, auth routes render with default branded colors and use the remote fallback background URI defined in `constants/auth-theme.ts`.
