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

/** 顶层渲染期异常兜底：子树渲染抛错时降级为单色错误卡与重载按钮。 */
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
          background: 'var(--bg-canvas)',
          color: 'var(--text-primary)',
          padding: '24px',
        }}
      >
        <div
          style={{
            maxWidth: '520px',
            width: '100%',
            border: '1px solid var(--border-color)',
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
            {i18n.t('error.title')}
          </h1>
          <p style={{ opacity: 0.7, margin: 0, fontSize: 'calc(13px * var(--font-scale, 1))' }}>
            {i18n.t('error.description')}
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
            <span>{i18n.t('error.reload')}</span>
          </button>
        </div>
      </div>
    );
  }
}
