# Importer Dashboard Preferences and Planning Helpers

This implementation note documents the frontend helpers added for the importer dashboard work.

## Theme preference

`apps/web/lib/theme.ts` stores `system`, `light`, or `dark` in `localStorage` and applies the resolved theme through `document.documentElement.dataset.theme`. The root layout includes a short boot script so the stored preference is applied before React hydration, reducing theme flicker.

## Locale preference

`apps/web/lib/i18n.ts` provides English, Spanish, and Mandarin strings for the first localized dashboard surfaces: navigation and the deposit flow. Missing strings fall back to English by design.

## Bond calendar export

`apps/web/lib/bond-calendar.ts` converts bond timeline events into an ICS payload and also builds Google Calendar and Outlook compose links for the next event. The helper is dependency-free so it can be wired into the timeline UI or an API feed without adding a package.

## Yield forecast horizons

`apps/web/lib/yieldForecast.ts` projects yield for 30, 90, and 365 day horizons from the current balance and annual yield basis points. The values are estimates only and do not modify on-chain state.