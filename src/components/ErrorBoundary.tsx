import React from 'react';
import { RotateCcw } from 'lucide-react';
import i18n from '../i18n';
import { zlogError } from '../lib/z-log';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * 顶层 React 渲染期异常兜底：任一子树渲染期抛错时以单色错误卡降级，
 * 提供重载按钮，替代整窗白屏。仅兜渲染期异常；异步 reject 由各调用侧
 * try/catch + toast 负责，不在此收敛。类组件无 hook，文案经 i18n 实例直取。
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    zlogError(`render crash: ${error.message} ${info.componentStack ?? ''}`.trimEnd());
  }

  private handleReload = () => {
    window.location.reload();
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const detail = error.message || String(error);
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--bg-primary, #141414)',
          color: 'var(--text-primary, #ffffff)',
          padding: '24px',
        }}
      >
        <div
          style={{
            maxWidth: '520px',
            width: '100%',
            border: '1px solid var(--border-primary, #333333)',
            borderRadius: '8px',
            padding: '32px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '12px',
            textAlign: 'center',
          }}
        >
          <RotateCcw size={32} strokeWidth={1.5} style={{ opacity: 0.7 }} aria-hidden="true" />
          <h1 style={{ fontSize: 'calc(18px * var(--font-scale, 1))', margin: 0, fontWeight: 590 }}>
            {i18n.t('error.title', { defaultValue: '界面出错了' })}
          </h1>
          <p style={{ opacity: 0.7, margin: 0, fontSize: 'calc(13px * var(--font-scale, 1))' }}>
            {i18n.t('error.description', {
              defaultValue: '应用遇到未预期的错误，界面已停止渲染。点击下方按钮重载即可恢复。',
            })}
          </p>
          <pre
            className="text-mono"
            style={{
              margin: 0,
              maxWidth: '100%',
              maxHeight: '160px',
              overflow: 'auto',
              opacity: 0.55,
              fontSize: 'calc(12px * var(--font-scale, 1))',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              userSelect: 'text',
            }}
          >
            {detail}
          </pre>
          <button
            type="button"
            className="btn-fluent btn-primary"
            style={{ marginTop: '8px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            onClick={this.handleReload}
          >
            <RotateCcw size={14} strokeWidth={1.5} aria-hidden="true" />
            <span>{i18n.t('error.reload', { defaultValue: '重载应用' })}</span>
          </button>
        </div>
      </div>
    );
  }
}
