import React from 'react';

/** 把路径拆成目录段（含末尾分隔符）与文件名段；没有分隔符时整段算文件名。 */
function splitPathForDisplay(path: string): { head: string; tail: string } {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  if (cut < 0) return { head: '', tail: path };
  return { head: path.slice(0, cut + 1), tail: path.slice(cut + 1) };
}

/** 安装路径单行显示：优先保留文件名段，窄宽度下仅截断目录前缀。 */
export const PathText: React.FC<{ path: string }> = ({ path }) => {
  const { head, tail } = splitPathForDisplay(path);
  return (
    <span className="manage-path-text">
      {head && <span className="manage-path-head">{head}</span>}
      <span className="manage-path-tail">{tail}</span>
    </span>
  );
};
