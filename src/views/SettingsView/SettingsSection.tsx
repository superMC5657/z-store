import React from 'react';

interface SettingsSectionProps {
  title: string;
  children: React.ReactNode;
}

export const SettingsSection: React.FC<SettingsSectionProps> = ({ title, children }) => {
  return (
    <div className="settings-section">
      <div className="settings-section-eyebrow">
        <span>{title}</span>
      </div>
      <div className="settings-group">
        {children}
      </div>
    </div>
  );
};
