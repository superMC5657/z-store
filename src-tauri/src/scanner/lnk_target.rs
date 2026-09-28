use super::AppScanner;
use std::path::{Path, PathBuf};

impl AppScanner {
    /// 解析 Windows 快捷方式 (.lnk) 的真实目标程序物理路径
    pub fn resolve_lnk_target(lnk_path: &Path) -> Option<PathBuf> {
        let data = std::fs::read(lnk_path).ok()?;
        if data.len() < 76 {
            return None;
        }

        // 1. 标准 MS-SHLLINK 结构体解析
        let flags = u32::from_le_bytes(data[0x14..0x18].try_into().ok()?);
        if (flags & 0x02) != 0 {
            // ShellLinkHeader 固定 76 字节；HasLinkTargetIDList (0x01) 置位时，
            // 头部之后是 LinkTargetIDList（u16 IDListSize + 变长 IDList），
            // LinkInfo 从 IDList 之后开始，而非固定偏移 76。
            let mut link_info_offset = 76usize;
            if (flags & 0x01) != 0 {
                if data.len() < link_info_offset + 2 {
                    // IDList 长度字段被截断：放弃结构化解析，走启发式分支
                    link_info_offset = data.len();
                } else {
                    let id_list_size = u16::from_le_bytes(
                        data[link_info_offset..link_info_offset + 2]
                            .try_into()
                            .ok()?,
                    ) as usize;
                    link_info_offset = link_info_offset.saturating_add(2 + id_list_size);
                }
            }
            if data.len() > link_info_offset + 28 {
                let link_info_size = u32::from_le_bytes(
                    data[link_info_offset..link_info_offset + 4]
                        .try_into()
                        .ok()?,
                ) as usize;
                let local_base_path_offset = u32::from_le_bytes(
                    data[link_info_offset + 16..link_info_offset + 20]
                        .try_into()
                        .ok()?,
                ) as usize;
                if local_base_path_offset > 0 && local_base_path_offset < link_info_size {
                    let abs_offset = link_info_offset + local_base_path_offset;
                    if abs_offset < data.len() {
                        let null_pos = data[abs_offset..]
                            .iter()
                            .position(|&b| b == 0)
                            .unwrap_or(data.len() - abs_offset);
                        if let Ok(path_str) =
                            std::str::from_utf8(&data[abs_offset..abs_offset + null_pos])
                        {
                            let pb = PathBuf::from(path_str);
                            if pb.is_file() {
                                return Some(pb);
                            }
                        }
                    }
                }
            }
        }

        // 2. 启发式字节串扫描备选（匹配 ?:\...\*.exe）
        let mut i = 0;
        while i + 3 < data.len() {
            if data[i].is_ascii_alphabetic() && data[i + 1] == b':' && data[i + 2] == b'\\' {
                let start = i;
                let mut end = start + 3;
                while end < data.len()
                    && data[end] >= 32
                    && data[end] < 127
                    && data[end] != b'"'
                    && data[end] != b'<'
                    && data[end] != b'>'
                {
                    end += 1;
                }
                if end > start + 7 {
                    if let Ok(candidate) = std::str::from_utf8(&data[start..end]) {
                        if candidate.to_lowercase().ends_with(".exe") {
                            let p = PathBuf::from(candidate);
                            if p.is_file() {
                                return Some(p);
                            }
                        }
                    }
                }
                i = end;
            } else {
                i += 1;
            }
        }

        None
    }
}

#[cfg(test)]
mod resolver_lnk_tests {
    use super::*;

    /// 测试本地临时目录 helper（仅测试代码，与 scanner/tests 收敛命名）。
    fn temp_test_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("zstore-lnk-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 构造 MS-SHLLINK 合成夹具：flags = 0x01|0x02（IDList + LinkInfo 共存），
    /// LinkInfo 起始于 76 + 2 + id_list_size（u16 IDListSize + 变长 IDList 之后）。
    /// IDList 填充 0xFF，使旧代码在固定偏移 76 处误读出的 link_info_size /
    /// local_base_path_offset 非法；目标路径使用 Unix 绝对路径，启发式分支
    ///（仅匹配 `X:\` 盘符模式）必然扫不到，从而把"结构化路径"与"启发式兜底"区分开：
    /// 旧代码返回 None，新代码应返回 Some。
    fn build_lnk_with_idlist_and_linkinfo(target: &str, id_list_size: usize) -> Vec<u8> {
        let mut data = vec![0u8; 76];
        // ShellLinkHeader 头部：HeaderSize + LinkCLSID + LinkFlags
        data[0x00..0x04].copy_from_slice(&76u32.to_le_bytes());
        let clsid: [u8; 16] = [
            0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x46,
        ];
        data[0x04..0x14].copy_from_slice(&clsid);
        // 包含 LinkTargetIDList (0x01) 或包含 LinkInfo (0x02)
        data[0x14..0x18].copy_from_slice(&0x03u32.to_le_bytes());

        // LinkTargetIDList：u16 长度 + 变长 IDList（0xFF 填充，破坏固定偏移误读）
        data.extend_from_slice(&(id_list_size as u16).to_le_bytes());
        data.extend(std::iter::repeat_n(0xFFu8, id_list_size));

        // LinkInfo（含最小 VolumeID + LocalBasePath ANSI 字符串）
        let path_bytes = target.as_bytes();
        let mut volume_id = [0u8; 16];
        volume_id[0x00..0x04].copy_from_slice(&16u32.to_le_bytes());
        volume_id[0x04..0x08].copy_from_slice(&1u32.to_le_bytes());
        volume_id[0x08..0x0C].copy_from_slice(&0x12345678u32.to_le_bytes());
        volume_id[0x0C..0x10].copy_from_slice(&16u32.to_le_bytes());
        let local_base_path_offset = 28 + volume_id.len();
        let link_info_size = (28 + volume_id.len() + path_bytes.len() + 1) as u32;
        let mut link_info = Vec::new();
        link_info.extend_from_slice(&link_info_size.to_le_bytes());
        link_info.extend_from_slice(&28u32.to_le_bytes());
        link_info.extend_from_slice(&0x01u32.to_le_bytes());
        link_info.extend_from_slice(&28u32.to_le_bytes());
        link_info.extend_from_slice(&(local_base_path_offset as u32).to_le_bytes());
        link_info.extend_from_slice(&0u32.to_le_bytes());
        link_info.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(link_info.len(), 28);
        link_info.extend_from_slice(&volume_id);
        link_info.extend_from_slice(path_bytes);
        link_info.push(0);
        assert_eq!(link_info.len(), link_info_size as usize);
        data.extend_from_slice(&link_info);
        data
    }

    #[test]
    fn lnk_with_idlist_resolves_through_structured_path() {
        let dir = temp_test_dir();
        let target = dir.join("fixture-target.exe");
        std::fs::write(&target, b"fake exe").unwrap();
        // 刻意使用正斜杠分隔符：Windows 上 is_file 照常通过，但启发式分支
        // 仅匹配 `X:\`（反斜杠）盘符模式，必然扫不到 —— 旧代码返回 None，
        // 新代码走结构化路径返回 Some，二者得以区分。
        let target_str = target.to_string_lossy().replace('\\', "/");

        let lnk_bytes = build_lnk_with_idlist_and_linkinfo(&target_str, 16);
        let lnk_path = dir.join("fixture-both-flags.lnk");
        std::fs::write(&lnk_path, &lnk_bytes).unwrap();

        let resolved = AppScanner::resolve_lnk_target(&lnk_path);
        assert_eq!(resolved, Some(PathBuf::from(&target_str)));

        std::fs::remove_file(&lnk_path).ok();
        std::fs::remove_file(&target).ok();
        std::fs::remove_dir(&dir).ok();
    }
}
