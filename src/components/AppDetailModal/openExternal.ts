import type { MouseEvent } from 'react';
import { tauriApi } from '../../services/api';

/** 外链经系统浏览器打开：预阻止默认跳转与冒泡，避免顺带触发卡片/弹层的点击收起。 */
export const handleOpenExternal = (e: MouseEvent, url: string): void => {
  e.preventDefault();
  e.stopPropagation();
  tauriApi.openUrl(url);
};
