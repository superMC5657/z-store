import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, AlertCircle, Copy, Check, ExternalLink, LogIn, LogOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { GitHubIcon } from './icons/PlatformIcons';
import { OAuthUser } from '../types';
import { api } from '../services/api';
import { notifyToast } from '../utils/notify';

interface DeviceSession {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  deadline: number;
  intervalMs: number;
}

export const OAuthAccountCard: React.FC = () => {
  const { t } = useTranslation();
  const [user, setUser] = useState<OAuthUser | null>(null);
  const [isLoadingUser, setIsLoadingUser] = useState(true);
  const [session, setSession] = useState<DeviceSession | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 连续轮询网络失败计数：抖动不断会话，攒够次数才停（用户码保留展示）
  const pollFailRef = useRef(0);

  const loadUser = async () => {
    setIsLoadingUser(true);
    try {
      const u = await api.getOAuthUser();
      setUser(u);
    } catch {
      setUser(null);
    } finally {
      setIsLoadingUser(false);
    }
  };

  useEffect(() => {
    loadUser();
    const refresh = () => loadUser();
    window.addEventListener('zstore:oauth-changed', refresh);
    return () => {
      window.removeEventListener('zstore:oauth-changed', refresh);
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, []);

  const stopPolling = () => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const schedulePoll = (deviceCode: string, deadline: number, intervalMs: number) => {
    stopPolling();
    pollTimerRef.current = setTimeout(async () => {
      if (Date.now() > deadline) {
        setError(t('oauth.poll_timeout'));
        setSession(null);
        return;
      }
      try {
        const res = await api.oauthDevicePoll(deviceCode);
        pollFailRef.current = 0;
        if (res.status === 'complete') {
          stopPolling();
          setSession(null);
          setError(null);
          await loadUser();
          notifyToast(t('oauth.login_success'), 'success');
          window.dispatchEvent(new CustomEvent('zstore:oauth-changed'));
        } else if (res.status === 'expired' || res.status === 'denied') {
          stopPolling();
          setSession(null);
          setError(res.status === 'expired' ? t('oauth.poll_expired') : t('oauth.poll_denied'));
        } else if (res.status === 'error') {
          stopPolling();
          setSession(null);
          setError(res.message || t('oauth.poll_error'));
        } else {
          schedulePoll(deviceCode, deadline, intervalMs);
        }
      } catch (e) {
        // 轮询只是查状态，网络抖动不断会话：提示后继续下一轮；
        // 连续多次失败才停，且保留用户码展示，用户可检查网络后重来。
        pollFailRef.current += 1;
        if (pollFailRef.current >= 10) {
          stopPolling();
          setError(t('oauth.network_failed'));
          return;
        }
        setError(t('oauth.network_retry', { count: pollFailRef.current, error: String(e).slice(0, 80) }));
        schedulePoll(deviceCode, deadline, intervalMs);
      }
    }, intervalMs);
  };

  const handleLogin = async () => {
    setIsStarting(true);
    setError(null);
    pollFailRef.current = 0;
    try {
      const res = await api.oauthDeviceStart();
      const deadline = Date.now() + res.expires_in * 1000;
      const intervalMs = Math.max(1000, res.interval * 1000);
      const verificationUri = res.verification_uri_complete || res.verification_uri;
      setSession({
        deviceCode: res.device_code,
        userCode: res.user_code,
        verificationUri,
        deadline,
        intervalMs,
      });
      schedulePoll(res.device_code, deadline, intervalMs);
      // 成功即自动拉起浏览器授权页；失败也不阻塞，卡片上仍保留手动按钮
      try {
        await api.openUrl(verificationUri);
      } catch {
        // ignore：用户可点「前往授权页」手动打开
      }
    } catch (e) {
      setError(t('oauth.login_failed', { error: String(e) }));
    } finally {
      setIsStarting(false);
    }
  };

  const handleCancelSession = () => {
    stopPolling();
    pollFailRef.current = 0;
    setSession(null);
    setError(null);
  };

  const handleCopyCode = async () => {
    if (!session) return;
    try {
      await navigator.clipboard.writeText(session.userCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(t('oauth.copy_failed'));
    }
  };

  const handleLogout = async () => {
    try {
      await api.oauthLogout();
    } catch (e) {
      notifyToast(t('oauth.logout_failed', { error: String(e) }), 'error');
      return;
    }
    setUser(null);
    notifyToast(t('oauth.logged_out'), 'info');
    window.dispatchEvent(new CustomEvent('zstore:oauth-changed'));
  };

  return (
    <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
        <div className="settings-row-info">
          <span style={{ fontWeight: 510, display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <GitHubIcon size={16} />
            <span>{t('oauth.title')}</span>
          </span>
          <span className="settings-row-desc">
            {user
              ? user.is_expired
                ? t('oauth.desc_expired')
                : t('oauth.desc_logged_in')
              : t('oauth.desc_anonymous')}
          </span>
        </div>
        {isLoadingUser ? (
          <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{t('oauth.loading_user')}</span>
        ) : user ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
              {user.avatar_url && (
                <img
                  src={user.avatar_url}
                  alt={user.login}
                  style={{
                    width: '28px',
                    height: '28px',
                    borderRadius: '50%',
                    opacity: user.is_expired ? 0.6 : 1,
                    filter: user.is_expired ? 'grayscale(50%)' : 'none',
                  }}
                />
              )}
              {user.is_expired && (
                <span
                  style={{
                    position: 'absolute',
                    right: '-2px',
                    bottom: '-2px',
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    backgroundColor: '#eab308',
                    border: '2px solid var(--bg-primary, #0f172a)',
                  }}
                  title={t('oauth.expired_tag')}
                />
              )}
            </div>
            <span style={{ fontSize: '13px', fontWeight: 510, color: user.is_expired ? '#eab308' : undefined }}>
              {user.login} {user.is_expired && t('oauth.expired_tag')}
            </span>
            {user.is_expired ? (
              <button
                type="button"
                className="btn-fluent btn-secondary"
                style={{ fontSize: '12px', padding: '6px 14px', display: 'flex', alignItems: 'center', gap: '6px' }}
                disabled={isStarting}
                onClick={handleLogin}
              >
                <LogIn size={13} strokeWidth={1.5} />
                <span>{t('oauth.relogin')}</span>
              </button>
            ) : null}
            <button
              type="button"
              className="btn-fluent btn-secondary"
              style={{ fontSize: '12px', padding: '6px 14px', display: 'flex', alignItems: 'center', gap: '6px' }}
              onClick={handleLogout}
            >
              <LogOut size={13} strokeWidth={1.5} />
              <span>{t('oauth.logout')}</span>
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn-fluent btn-primary"
            style={{ fontSize: '12px', padding: '6px 16px', display: 'flex', alignItems: 'center', gap: '6px' }}
            disabled={isStarting}
            onClick={handleLogin}
          >
            <LogIn size={13} strokeWidth={1.5} />
            <span>{isStarting ? t('oauth.starting') : t('oauth.login')}</span>
          </button>
        )}
      </div>

      {user && user.is_expired && !session && (
        <div
          style={{
            padding: '10px 14px',
            borderRadius: '6px',
            background: 'rgba(234, 179, 8, 0.1)',
            border: '1px solid rgba(234, 179, 8, 0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            marginTop: '4px',
          }}
        >
          <div style={{ fontSize: '12px', color: '#eab308', lineHeight: '1.5', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AlertTriangle size={15} style={{ flexShrink: 0 }} />
            <span>
              <strong>{t('oauth.token_expired_title')}</strong>: {t('oauth.token_expired_desc')}
            </span>
          </div>
          <button
            type="button"
            className="btn-fluent btn-primary"
            style={{ fontSize: '12px', padding: '5px 14px', flexShrink: 0 }}
            onClick={handleLogin}
            disabled={isStarting}
          >
            {t('oauth.reauth_now')}
          </button>
        </div>
      )}

      {user && user.has_list_scope === false && !session && (
        <div
          style={{
            padding: '10px 14px',
            borderRadius: '6px',
            background: 'rgba(234, 179, 8, 0.1)',
            border: '1px solid rgba(234, 179, 8, 0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            marginTop: '4px',
          }}
        >
          <div style={{ fontSize: '12px', color: 'var(--status-warning)', lineHeight: '1.5', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <AlertTriangle size={14} style={{ flexShrink: 0 }} />
            <span><strong>{t('oauth.scope_alert_title')}</strong>: {t('oauth.scope_alert_desc')}</span>
          </div>
          <button
            type="button"
            className="btn-fluent btn-primary"
            style={{ fontSize: '12px', padding: '5px 12px', whiteSpace: 'nowrap' }}
            disabled={isStarting}
            onClick={handleLogin}
          >
            {isStarting ? t('oauth.starting') : t('oauth.reauth')}
          </button>
        </div>
      )}

      {error && (
        <span style={{ fontSize: '12px', color: 'var(--status-error)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <AlertCircle size={13} />
          <span>{error}</span>
        </span>
      )}

      {session && (
        <div
          style={{
            padding: '14px 16px',
            borderRadius: '8px',
            background: 'var(--card-bg-subtle, rgba(255,255,255,0.03))',
            border: '1px solid var(--border-color)',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          <span style={{ fontSize: '13px', fontWeight: 590, letterSpacing: '-0.015em' }}>{t('oauth.complete_in_browser')}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <code
              style={{
                fontSize: '20px',
                fontWeight: 590,
                letterSpacing: '3px',
                padding: '6px 14px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-input)',
                border: '1px solid var(--border-subtle)',
                userSelect: 'all',
              }}
            >
              {session.userCode}
            </code>
            <button
              type="button"
              className="btn-fluent btn-secondary"
              style={{ fontSize: '12px', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px' }}
              onClick={handleCopyCode}
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              <span>{copied ? t('oauth.copied') : t('oauth.copy_code')}</span>
            </button>
            <button
              type="button"
              className="btn-fluent btn-primary"
              style={{ fontSize: '12px', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px' }}
              onClick={() => api.openUrl(session.verificationUri)}
            >
              <span>{t('oauth.open_auth_page')}</span>
              <ExternalLink size={12} />
            </button>
            <button
              type="button"
              className="btn-fluent btn-secondary"
              style={{ fontSize: '12px', padding: '6px 12px' }}
              onClick={handleCancelSession}
            >
              {t('common.cancel')}
            </button>
          </div>
          <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
            {t('oauth.enter_code_hint')}
          </span>
        </div>
      )}
    </div>
  );
};
