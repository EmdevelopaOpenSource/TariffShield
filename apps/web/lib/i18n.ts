'use client';

import { useEffect, useMemo, useState } from 'react';

export type Locale = 'en' | 'es' | 'zh';
export const LOCALE_STORAGE_KEY = 'tariffshield.locale';
export const SUPPORTED_LOCALES: Locale[] = ['en', 'es', 'zh'];
export const LOCALE_LABELS: Record<Locale, string> = { en: 'English', es: 'Espanol', zh: 'Mandarin' };

type MessageKey =
  | 'nav.dashboard' | 'nav.admin' | 'nav.logout' | 'nav.login' | 'nav.signup' | 'nav.testnet' | 'nav.mainnet'
  | 'deposit.tour' | 'deposit.minimum' | 'deposit.enterAmount' | 'deposit.invalidAmount' | 'deposit.minimumError'
  | 'deposit.next' | 'deposit.amount' | 'deposit.to' | 'deposit.cancel' | 'deposit.confirm' | 'deposit.ready'
  | 'deposit.readyCopy' | 'deposit.depositing' | 'deposit.deposit' | 'deposit.success' | 'deposit.makeAnother' | 'deposit.done';

const messages: Record<Locale, Record<MessageKey, string>> = {
  en: {
    'nav.dashboard': 'Bond dashboard', 'nav.admin': 'Surety admin', 'nav.logout': 'Log out', 'nav.login': 'Log in', 'nav.signup': 'Sign up', 'nav.testnet': 'Testnet', 'nav.mainnet': 'Mainnet',
    'deposit.tour': 'Show guided tour', 'deposit.minimum': 'Minimum deposit amount: 0.1 XLM', 'deposit.enterAmount': 'Please enter a deposit amount.', 'deposit.invalidAmount': 'Amount must be greater than 0 XLM.', 'deposit.minimumError': 'Minimum deposit amount is 0.1 XLM.', 'deposit.next': 'Next', 'deposit.amount': 'Deposit amount', 'deposit.to': 'To', 'deposit.cancel': 'Cancel', 'deposit.confirm': 'Confirm', 'deposit.ready': 'Ready to deposit?', 'deposit.readyCopy': 'This will be signed by your Stellar account.', 'deposit.depositing': 'Depositing...', 'deposit.deposit': 'Deposit', 'deposit.success': 'Deposit successful', 'deposit.makeAnother': 'Make another deposit', 'deposit.done': 'Done',
  },
  es: {
    'nav.dashboard': 'Panel de fianza', 'nav.admin': 'Admin de garantia', 'nav.logout': 'Cerrar sesion', 'nav.login': 'Iniciar sesion', 'nav.signup': 'Registrarse', 'nav.testnet': 'Red de prueba', 'nav.mainnet': 'Red principal',
    'deposit.tour': 'Mostrar guia', 'deposit.minimum': 'Deposito minimo: 0.1 XLM', 'deposit.enterAmount': 'Ingresa un monto de deposito.', 'deposit.invalidAmount': 'El monto debe ser mayor que 0 XLM.', 'deposit.minimumError': 'El deposito minimo es 0.1 XLM.', 'deposit.next': 'Siguiente', 'deposit.amount': 'Monto del deposito', 'deposit.to': 'Destino', 'deposit.cancel': 'Cancelar', 'deposit.confirm': 'Confirmar', 'deposit.ready': 'Listo para depositar?', 'deposit.readyCopy': 'Tu cuenta Stellar firmara esta operacion.', 'deposit.depositing': 'Depositando...', 'deposit.deposit': 'Depositar', 'deposit.success': 'Deposito exitoso', 'deposit.makeAnother': 'Hacer otro deposito', 'deposit.done': 'Listo',
  },
  zh: {
    'nav.dashboard': '保证金面板', 'nav.admin': '担保管理', 'nav.logout': '退出登录', 'nav.login': '登录', 'nav.signup': '注册', 'nav.testnet': '测试网', 'nav.mainnet': '主网',
    'deposit.tour': '显示引导', 'deposit.minimum': '最低存款: 0.1 XLM', 'deposit.enterAmount': '请输入存款金额。', 'deposit.invalidAmount': '金额必须大于 0 XLM。', 'deposit.minimumError': '最低存款金额为 0.1 XLM。', 'deposit.next': '下一步', 'deposit.amount': '存款金额', 'deposit.to': '至', 'deposit.cancel': '取消', 'deposit.confirm': '确认', 'deposit.ready': '准备存款?', 'deposit.readyCopy': '这将由你的 Stellar 账户签名。', 'deposit.depositing': '存款中...', 'deposit.deposit': '存款', 'deposit.success': '存款成功', 'deposit.makeAnother': '再次存款', 'deposit.done': '完成',
  },
};

function readLocale(): Locale {
  const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  return SUPPORTED_LOCALES.includes(stored as Locale) ? (stored as Locale) : 'en';
}
export function t(locale: Locale, key: MessageKey) { return messages[locale]?.[key] ?? messages.en[key]; }
export function useLocalePreference() {
  const [locale, setLocaleState] = useState<Locale>('en');
  useEffect(() => setLocaleState(readLocale()), []);
  const setLocale = useMemo(() => (next: Locale) => { window.localStorage.setItem(LOCALE_STORAGE_KEY, next); setLocaleState(next); }, []);
  return { locale, setLocale };
}