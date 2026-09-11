import React from 'react';

interface IconProps {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

export const WindowsIcon: React.FC<IconProps> = ({ size = 14, className, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    className={className}
    style={style}
    aria-label="Windows"
  >
    <path d="M3 5.557L10.395 4.5v6.79H3V5.557zm0 12.886l7.395 1.057v-6.79H3v5.733zM11.535 4.34L21 3v8.29h-9.465V4.34zm0 15.32L21 21v-8.29h-9.465v6.95z" />
  </svg>
);

export const AppleIcon: React.FC<IconProps> = ({ size = 14, className, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    className={className}
    style={style}
    aria-label="Apple macOS"
  >
    <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 6.37c.62-.75 1.04-1.8 1.01-2.85-.9.04-1.98.6-2.62 1.34-.57.65-1.06 1.71-1.01 2.73 1 .08 2.02-.48 2.62-1.22z" />
  </svg>
);

export const LinuxIcon: React.FC<IconProps> = ({ size = 14, className, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    style={style}
    aria-label="Linux"
  >
    <path d="M12 2C9.5 2 8 4 8 7v4c0 1.5-.5 3-1.5 4-1 .8-1.5 2-1.5 3.5 0 2 2 3.5 7 3.5s7-1.5 7-3.5c0-1.5-.5-2.7-1.5-3.5C16.5 14 16 12.5 16 11V7c0-3-1.5-5-4-5z" />
    <circle cx="10" cy="8" r="1" fill="currentColor" />
    <circle cx="14" cy="8" r="1" fill="currentColor" />
    <path d="M10 11c1 .5 3 .5 4 0" />
    <path d="M6 19c-1.5.5-2.5 1.5-2 2.5 1 1.5 4 1 5 .5" />
    <path d="M18 19c1.5.5 2.5 1.5 2 2.5-1 1.5-4 1-5 .5" />
  </svg>
);

export const AndroidIcon: React.FC<IconProps> = ({ size = 14, className, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    style={style}
    aria-label="Android"
  >
    <path d="M4 10a8 8 0 0 1 16 0v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7z" />
    <line x1="7" y1="4" x2="9" y2="7" />
    <line x1="17" y1="4" x2="15" y2="7" />
    <circle cx="9" cy="11" r="1" fill="currentColor" />
    <circle cx="15" cy="11" r="1" fill="currentColor" />
  </svg>
);

export const IosIcon: React.FC<IconProps> = ({ size = 14, className, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    style={style}
    aria-label="iOS"
  >
    <rect width="14" height="20" x="5" y="2" rx="3" />
    <path d="M12 18h.01" />
  </svg>
);

export const GitHubIcon: React.FC<IconProps> = ({ size = 14, className, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    className={className}
    style={style}
    aria-label="GitHub"
  >
    <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
  </svg>
);

export const GitLabIcon: React.FC<IconProps> = ({ size = 14, className, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    className={className}
    style={style}
    aria-label="GitLab"
  >
    <path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 0 1-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 0 1 5.5 2a.43.43 0 0 1 .41.29l2.43 7.49h7.32l2.43-7.49a.43.43 0 0 1 .41-.29.42.42 0 0 1 .41.22l2.44 7.51 1.22 3.78a.84.84 0 0 1-.32.94z" />
  </svg>
);

export const CodebergIcon: React.FC<IconProps> = ({ size = 14, className, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    className={className}
    style={style}
    aria-label="Codeberg"
  >
    <path d="M11.996 2.004C6.476 2.004 2 6.48 2 12c0 5.52 4.476 9.996 9.996 9.996 5.52 0 10.004-4.476 10.004-9.996 0-5.52-4.484-9.996-10.004-9.996zm-1.04 4.54a1.2 1.2 0 0 1 2.08 0l4.56 7.9c.46.8-.12 1.8-1.04 1.8H5.44c-.92 0-1.5-1-.04-1.8l4.56-7.9z" />
  </svg>
);

export const GiteaIcon: React.FC<IconProps> = ({ size = 14, className, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    style={style}
    aria-label="Gitea"
  >
    <path d="M17 8h1a4 4 0 1 1 0 8h-1" />
    <path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z" />
    <line x1="6" y1="2" x2="6" y2="4" />
    <line x1="10" y1="2" x2="10" y2="4" />
    <line x1="14" y1="2" x2="14" y2="4" />
  </svg>
);

export const PlatformIcon: React.FC<{ platform: string; size?: number; className?: string; style?: React.CSSProperties }> = ({
  platform,
  size = 14,
  className,
  style,
}) => {
  const p = platform.toLowerCase();
  if (p === 'windows' || p === 'win') return <WindowsIcon size={size} className={className} style={style} />;
  if (p === 'macos' || p === 'mac' || p === 'darwin') return <AppleIcon size={size} className={className} style={style} />;
  if (p === 'linux') return <LinuxIcon size={size} className={className} style={style} />;
  if (p === 'android') return <AndroidIcon size={size} className={className} style={style} />;
  if (p === 'ios') return <IosIcon size={size} className={className} style={style} />;
  return <WindowsIcon size={size} className={className} style={style} />;
};

export const ForgeIcon: React.FC<{ forge: string; size?: number; className?: string; style?: React.CSSProperties }> = ({
  forge,
  size = 14,
  className,
  style,
}) => {
  const f = forge.toLowerCase();
  if (f === 'gitlab') return <GitLabIcon size={size} className={className} style={style} />;
  if (f === 'codeberg') return <CodebergIcon size={size} className={className} style={style} />;
  if (f === 'gitea') return <GiteaIcon size={size} className={className} style={style} />;
  return <GitHubIcon size={size} className={className} style={style} />;
};
