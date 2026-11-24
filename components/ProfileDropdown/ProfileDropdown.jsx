'use client';

/**
 * @author: @dorianbaffier
 * @description: Account Menu
 * @version: 2.0.0
 * @license: MIT
 * @website: https://kokonutui.com
 * @github: https://github.com/kokonut-labs/kokonutui
 */

import {
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  CreditCard,
  LogOut,
  Monitor,
  Moon,
  Plus,
  Settings,
  Sun,
  User,
} from 'lucide-react';
import {
  animate,
  motion,
  useMotionTemplate,
  useMotionValue,
  useReducedMotion,
} from 'motion/react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import './ProfileDropdown.css';

const SAMPLE_ACCOUNTS = [
  { id: 'personal', name: 'Trader', email: 'trader@momentumchasers.com', plan: 'NORMAL' },
  { id: 'vip', name: 'VIP Research', email: 'vip@momentumchasers.com', plan: 'VIP PRO' },
  { id: 'guest', name: 'Guest Trader', email: 'guest@momentumchasers.com', plan: 'TRIAL' }
];

const SAMPLE_ITEMS = [
  { label: 'Trading Profile', icon: <User className="size-4" />, value: 'Active' },
  { label: 'Terminal Settings', icon: <Settings className="size-4" />, value: '⌘,' },
  { label: 'VIP Pass & Billing', icon: <CreditCard className="size-4" />, value: 'Extend' },
];

const THEMES = [
  { id: 'light', label: 'Light', Icon: Sun },
  { id: 'dark', label: 'Dark', Icon: Moon },
];

const PANEL_W = 310;
const RADIUS = 14;
const SPRING = { type: 'spring', duration: 0.3, bounce: 0 };
const INDICATOR_SPRING = { type: 'spring', duration: 0.25, bounce: 0 };
const INSTANT = { duration: 0 };
const EASE_OUT = [0.23, 1, 0.32, 1];

function initialsOf(account) {
  if (account.initials) return account.initials;
  return account.name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase() || 'T';
}

function viaOf(event) {
  return event.detail === 0 ? 'keyboard' : 'pointer';
}

function Avatar({ account, tone = 0, className = '' }) {
  return (
    <span
      aria-hidden="true"
      className={`kokonut-avatar ${className}`}
      style={{
        background: 'linear-gradient(135deg, #10b981, #059669)',
        color: '#ffffff'
      }}
    >
      {initialsOf(account)}
    </span>
  );
}

function HoldSignOut({ duration = 1200, onComplete }) {
  const [holding, setHolding] = useState(false);
  const [done, setDone] = useState(false);
  const [nudge, setNudge] = useState(false);
  const timer = useRef(undefined);
  const nudgeTimer = useRef(undefined);

  useEffect(() => () => {
    window.clearTimeout(timer.current);
    window.clearTimeout(nudgeTimer.current);
  }, []);

  const start = (via) => {
    if (timer.current !== undefined || done) return;
    window.clearTimeout(nudgeTimer.current);
    setNudge(false);
    setHolding(true);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      setHolding(false);
      setDone(true);
      onComplete?.(via);
    }, duration);
  };

  const cancel = () => {
    if (timer.current === undefined) return;
    window.clearTimeout(timer.current);
    timer.current = undefined;
    setHolding(false);
    setNudge(true);
    nudgeTimer.current = window.setTimeout(() => setNudge(false), 1400);
  };

  return (
    <button
      className="kokonut-menu-item kokonut-hold-signout"
      data-menu-item=""
      onBlur={cancel}
      onClick={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (!e.repeat) start('keyboard');
        }
      }}
      onKeyUp={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          cancel();
        }
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        start('pointer');
      }}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      type="button"
    >
      <div className="kokonut-hold-inner">
        <LogOut className="size-4" />
        <span className="flex-1">Sign out</span>
        <span className="kokonut-hold-badge">
          {nudge ? 'Keep holding' : 'Hold to Sign out'}
        </span>
      </div>
      <span
        aria-hidden="true"
        className="kokonut-hold-fill"
        style={{
          clipPath: holding || done ? 'inset(0 0 0 0 round 8px)' : 'inset(0 100% 0 0 round 8px)',
          transition: holding ? `clip-path ${duration}ms linear` : 'clip-path 240ms cubic-bezier(0.23, 1, 0.32, 1)'
        }}
      >
        <LogOut className="size-4" />
        <span className="flex-1">Sign out</span>
        <span className="kokonut-hold-badge">Signing out...</span>
      </span>
    </button>
  );
}

export default function ProfileDropdown({
  accounts = SAMPLE_ACCOUNTS,
  defaultAccountId,
  onAccountChange,
  items = SAMPLE_ITEMS,
  defaultTheme = 'dark',
  onSignOut,
  holdDuration = 1200,
  className = ''
}) {
  const uid = useId();
  const [phase, setPhase] = useState('closed');
  const [page, setPage] = useState('main');
  const [accountId, setAccountId] = useState(defaultAccountId ?? accounts[0]?.id);
  const [theme, setTheme] = useState(defaultTheme);

  const wrapperRef = useRef(null);
  const triggerRef = useRef(null);

  const account = accounts.find((a) => a.id === accountId) || accounts[0];
  const others = accounts.filter((a) => a.id !== account.id);

  // Close on outside click
  useEffect(() => {
    if (phase !== 'open') return;
    const onDown = (e) => {
      if (!wrapperRef.current?.contains(e.target)) {
        setPhase('closed');
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [phase]);

  return (
    <div className={`kokonut-profile-dropdown ${className}`} ref={wrapperRef}>
      {/* TRIGGER PILL */}
      <button
        ref={triggerRef}
        type="button"
        className="kokonut-trigger-btn"
        aria-expanded={phase === 'open'}
        onClick={() => {
          setPhase((p) => (p === 'open' ? 'closed' : 'open'));
          setPage('main');
        }}
      >
        <Avatar account={account} />
        <div className="kokonut-trigger-info">
          <span className="kokonut-trigger-name">{account.name}</span>
          <span className="kokonut-trigger-plan">{account.plan || 'NORMAL'}</span>
        </div>
        <ChevronsUpDown className="kokonut-chevron" />
      </button>

      {/* FLOATING POPUP MENU */}
      {phase === 'open' && (
        <div className="kokonut-menu-panel" style={{ width: PANEL_W }}>
          <div
            className="kokonut-pages-wrapper"
            style={{
              transform: page === 'main' ? 'translateX(0)' : `translateX(-${PANEL_W}px)`
            }}
          >
            {/* MAIN PAGE */}
            <div className="kokonut-page" style={{ width: PANEL_W }}>
              <div className="kokonut-header-card">
                <Avatar account={account} className="kokonut-avatar-large" />
                <div className="kokonut-header-user">
                  <div className="kokonut-header-name-row">
                    <span className="kokonut-header-name">{account.name}</span>
                    <span className="kokonut-header-plan">{account.plan || 'NORMAL'}</span>
                  </div>
                  <span className="kokonut-header-email">{account.email}</span>
                </div>
              </div>

              {/* THEME ROW */}
              <div className="kokonut-control-row">
                <span className="kokonut-row-label">Theme</span>
                <div className="kokonut-theme-group">
                  {THEMES.map(({ id, label, Icon }) => (
                    <button
                      key={id}
                      type="button"
                      className={`kokonut-theme-btn ${theme === id ? 'active' : ''}`}
                      onClick={() => setTheme(id)}
                      title={label}
                    >
                      <Icon className="size-3.5" />
                    </button>
                  ))}
                </div>
              </div>

              <div className="kokonut-divider" />

              {/* MENU ITEMS */}
              <div className="kokonut-items-list">
                {items.map((item, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className="kokonut-menu-item"
                    onClick={() => {
                      item.onSelect?.();
                      setPhase('closed');
                    }}
                  >
                    <span className="kokonut-item-icon">{item.icon}</span>
                    <span className="flex-1 text-left">{item.label}</span>
                    {item.value && <span className="kokonut-item-val">{item.value}</span>}
                  </button>
                ))}

                {/* SWITCH ACCOUNT TRIGGER */}
                {accounts.length > 1 && (
                  <button
                    type="button"
                    className="kokonut-menu-item"
                    onClick={() => setPage('accounts')}
                  >
                    <span className="flex -space-x-1.5">
                      {others.slice(0, 2).map((other) => (
                        <Avatar key={other.id} account={other} className="kokonut-avatar-mini" />
                      ))}
                    </span>
                    <span className="flex-1 text-left">Switch account</span>
                    <ChevronRight className="size-4 text-zinc-400" />
                  </button>
                )}
              </div>

              <div className="kokonut-divider" />

              {/* HOLD TO SIGN OUT */}
              <HoldSignOut
                duration={holdDuration}
                onComplete={() => {
                  onSignOut?.();
                  setPhase('closed');
                }}
              />
            </div>

            {/* ACCOUNTS SWITCHER PAGE */}
            <div className="kokonut-page" style={{ width: PANEL_W }}>
              <button
                type="button"
                className="kokonut-menu-item kokonut-back-btn"
                onClick={() => setPage('main')}
              >
                <ChevronLeft className="size-4" />
                <span>Switch account</span>
              </button>

              <div className="kokonut-divider" />

              <div className="kokonut-items-list">
                {accounts.map((entry) => {
                  const checked = entry.id === account.id;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      className={`kokonut-menu-item ${checked ? 'active' : ''}`}
                      onClick={() => {
                        setAccountId(entry.id);
                        onAccountChange?.(entry);
                        setPage('main');
                      }}
                    >
                      <Avatar account={entry} className="size-7" />
                      <div className="flex-1 text-left min-w-0">
                        <div className="truncate text-sm font-semibold">{entry.name}</div>
                        <div className="truncate text-xs opacity-60">{entry.email}</div>
                      </div>
                      {checked && <Check className="size-4 text-emerald-400" />}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
