// FR-7: GitHub 账号（OAuth Device Flow）卡片
// IPCs: oauth_device_start / oauth_device_poll / get_oauth_user / oauth_logout
// Rust 侧并发实现中；所有调用 try/catch，后端未就绪时内联提示、不阻塞。
// 登录成功后派发 `zstore:oauth-changed`，App 根组件据此刷新详情弹窗的标星门控。
import React, { useEffect, useRef, useState } from 'react';
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
  const [user, setUser] = useState<OAuthUser | null>(null);
  const [isLoadingUser, setIsLoadingUser] = useState(true);
  const [session, setSession] = useState<DeviceSession | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        setError('授权已超时，请重新发起登录');
        setSession(null);
        return;
      }
      try {
        const res = await api.oauthDevicePoll(deviceCode);
        if (res.status === 'complete') {
          stopPolling();
          setSession(null);
          setError(null);
          await loadUser();
          notifyToast('GitHub 账号登录成功', 'success');
          window.dispatchEvent(new CustomEvent('zstore:oauth-changed'));
        } else if (res.status === 'expired' || res.status === 'denied') {
          stopPolling();
          setSession(null);
          setError(res.status === 'expired' ? '授权已过期，请重新发起登录' : '已取消授权，可随时重新登录');
        } else if (res.status === 'error') {
          stopPolling();
          setSession(null);
          setError(res.message || '授权轮询异常，请重试');
        } else {
          schedulePoll(deviceCode, deadline, intervalMs);
        }
      } catch (e) {
        stopPolling();
        setSession(null);
        setError(`授权轮询失败: ${String(e)}`);
      }
    }, intervalMs);
  };

  const handleLogin = async () => {
    setIsStarting(true);
    setError(null);
    try {
      const res = await api.oauthDeviceStart();
      const deadline = Date.now() + res.expires_in * 1000;
      const intervalMs = Math.max(1000, res.interval * 1000);
      setSession({
        deviceCode: res.device_code,
        userCode: res.user_code,
        verificationUri: res.verification_uri_complete || res.verification_uri,
        deadline,
        intervalMs,
      });
      schedulePoll(res.device_code, deadline, intervalMs);
    } catch (e) {
      setError(`发起登录失败: ${String(e)}`);
    } finally {
      setIsStarting(false);
    }
  };

  const handleCancelSession = () => {
    stopPolling();
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
      setError('复制失败，请手动选中用户码');
    }
  };

  const handleLogout = async () => {
    try {
      await api.oauthLogout();
    } catch (e) {
      notifyToast(`退出登录失败: ${String(e)}`, 'error');
      return;
    }
    setUser(null);
    notifyToast('已退出 GitHub 账号', 'info');
    window.dispatchEvent(new CustomEvent('zstore:oauth-changed'));
  };

  return (
    <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
        <div className="settings-row-info">
          <span style={{ fontWeight: 600 }}>🐙 GitHub 账号</span>
          <span className="settings-row-desc">
            {user ? '已完成 OAuth 授权，可使用标星同步与问题反馈' : '登录后可对应用标星（★），并直达仓库提交问题反馈'}
          </span>
        </div>
        {isLoadingUser ? (
          <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>正在读取登录态...</span>
        ) : user ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {user.avatar_url && (
              <img
                src={user.avatar_url}
                alt={user.login}
                style={{ width: '28px', height: '28px', borderRadius: '50%' }}
              />
            )}
            <span style={{ fontSize: '13px', fontWeight: 600 }}>{user.login}</span>
            <button
              type="button"
              className="btn-fluent btn-secondary"
              style={{ fontSize: '12px', padding: '6px 14px' }}
              onClick={handleLogout}
            >
              退出
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn-fluent btn-primary"
            style={{ fontSize: '12px', padding: '6px 16px' }}
            disabled={isStarting}
            onClick={handleLogin}
          >
            {isStarting ? '正在发起...' : '登录'}
          </button>
        )}
      </div>

      {user && (
        <span style={{ fontSize: '12px', color: '#10b981' }}>✅ 已认证 5000/h 限额</span>
      )}

      {error && (
        <span style={{ fontSize: '12px', color: '#ef4444' }}>⚠️ {error}</span>
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
          <span style={{ fontSize: '13px', fontWeight: 600 }}>在浏览器中完成授权（正在自动轮询，请勿关闭）</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <code
              style={{
                fontSize: '22px',
                fontWeight: 700,
                letterSpacing: '4px',
                padding: '6px 14px',
                borderRadius: '6px',
                background: 'rgba(0,0,0,0.25)',
                userSelect: 'all',
              }}
            >
              {session.userCode}
            </code>
            <button
              type="button"
              className="btn-fluent btn-secondary"
              style={{ fontSize: '12px', padding: '6px 12px' }}
              onClick={handleCopyCode}
            >
              {copied ? '✓ 已复制' : '复制用户码'}
            </button>
            <button
              type="button"
              className="btn-fluent btn-primary"
              style={{ fontSize: '12px', padding: '6px 12px' }}
              onClick={() => api.openUrl(session.verificationUri)}
            >
              前往授权页 ↗
            </button>
            <button
              type="button"
              className="btn-fluent btn-secondary"
              style={{ fontSize: '12px', padding: '6px 12px' }}
              onClick={handleCancelSession}
            >
              取消
            </button>
          </div>
          <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
            授权地址：{session.verificationUri}（输入上方用户码完成绑定）
          </span>
        </div>
      )}
    </div>
  );
};
