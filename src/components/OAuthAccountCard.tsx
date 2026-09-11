import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, AlertTriangle, AlertCircle, Copy, Check, ExternalLink, LogIn, LogOut } from 'lucide-react';
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
        setError('授权已超时，请重新发起登录');
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
        // 轮询只是查状态，网络抖动不断会话：提示后继续下一轮；
        // 连续多次失败才停，且保留用户码展示，用户可检查网络后重来。
        pollFailRef.current += 1;
        if (pollFailRef.current >= 10) {
          stopPolling();
          setError('网络多次失败，已停止轮询；用户码仍在有效期内，可检查网络后取消重来');
          return;
        }
        setError(`网络波动，自动重试中 (${pollFailRef.current})：${String(e).slice(0, 80)}`);
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
      setError(`发起登录失败: ${String(e)}`);
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
          <span style={{ fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <GitHubIcon size={16} />
            <span>GitHub 账号</span>
          </span>
          <span className="settings-row-desc">
            {user ? '已登录，享有 5,000 次/小时 API 配额' : '登录后享有 5,000 次/小时 API 配额及标星能力'}
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
              style={{ fontSize: '12px', padding: '6px 14px', display: 'flex', alignItems: 'center', gap: '6px' }}
              onClick={handleLogout}
            >
              <LogOut size={12} />
              <span>退出</span>
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
            <LogIn size={12} />
            <span>{isStarting ? '正在发起...' : '登录'}</span>
          </button>
        )}
      </div>

      {user && (
        <span style={{ fontSize: '12px', color: 'var(--status-success)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <CheckCircle2 size={13} />
          <span>已享有 <strong>5,000 次/小时</strong> API 访问配额</span>
        </span>
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
            <span><strong>权限需升级</strong>：当前授权缺少 user 权限，无法同步标星清单，建议重新授权。</span>
          </div>
          <button
            type="button"
            className="btn-fluent btn-primary"
            style={{ fontSize: '12px', padding: '5px 12px', whiteSpace: 'nowrap' }}
            disabled={isStarting}
            onClick={handleLogin}
          >
            {isStarting ? '发起中...' : '重新授权'}
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
          <span style={{ fontSize: '13px', fontWeight: 600 }}>请在浏览器中完成授权</span>
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
              style={{ fontSize: '12px', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px' }}
              onClick={handleCopyCode}
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              <span>{copied ? '已复制' : '复制用户码'}</span>
            </button>
            <button
              type="button"
              className="btn-fluent btn-primary"
              style={{ fontSize: '12px', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px' }}
              onClick={() => api.openUrl(session.verificationUri)}
            >
              <span>前往授权页</span>
              <ExternalLink size={12} />
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
            在授权页输入上方用户码即可完成绑定
          </span>
        </div>
      )}
    </div>
  );
};
