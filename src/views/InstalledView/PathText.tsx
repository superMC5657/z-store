import React from 'react';

/** 把路径拆成目录段（含末尾分隔符）与文件名段；没有分隔符时整段算文件名。 */
function splitPathForDisplay(path: string): { head: string; tail: string } {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  if (cut < 0) return { head: '', tail: path };
  return { head: path.slice(0, cut + 1), tail: path.slice(cut + 1) };
}

/**
 * 安装路径单行显示：目录段可被截断（末尾省略号），文件名段尽量完整保留，
 * 窄宽度下呈现为 `C:\Users\…\ZCode.exe`，而不是整段换行或丢掉文件名。
 */
export const PathText: React.FC<{ path: string }> = ({ path }) => {
  const { head, tail } = splitPathForDisplay(path);
  return (
    <span className="manage-path-text">
      {head && <span className="manage-path-head">{head}</span>}
      <span className="manage-path-tail">{tail}</span>
    </span>
  );
};
