import React from 'react';
import { DataBackupRow } from '../../../components/DataBackupRow';

interface DataManagementSectionProps {
  installedCount: number;
}

export const DataManagementSection: React.FC<DataManagementSectionProps> = ({ installedCount }) => (
  <DataBackupRow installedCount={installedCount} />
);
