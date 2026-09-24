import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'TariffShield — Soroban customs-bond collateral rail',
  description:
    'US importers post yield-bearing USDC instead of dead-weight cash collateral. Soroban smart contracts auto-top-up bonds during tariff spikes. Stellar testnet build.',
};

const themeBootScript = `try{const stored=window.localStorage.getItem('tariffshield.theme')||'system';const system=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';const resolved=stored==='light'||stored==='dark'?stored:system;document.documentElement.dataset.theme=resolved;document.documentElement.dataset.themePreference=stored;document.documentElement.style.colorScheme=resolved;}catch{}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeBootScript }} /></head>
      <body>{children}</body>
    </html>
  );
}