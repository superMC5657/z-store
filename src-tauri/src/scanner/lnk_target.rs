//! Windows 快捷方式（MS-SHLLINK）目标解析：结构化读取 LinkInfo（Unicode 优先、ANSI 按系统
//! 代码页解码）与 StringData 相对路径，失败时按字节启发式扫描 `X:\...\*.exe`。
//! 解析本身是纯字节处理，跨平台可测；只有 ANSI 代码页解码依赖 Win32。

use super::AppScanner;
use std::path::{Path, PathBuf};

const HEADER_SIZE: usize = 76;
const HAS_LINK_TARGET_ID_LIST: u32 = 0x01;
const HAS_LINK_INFO: u32 = 0x02;
const HAS_NAME: u32 = 0x04;
const HAS_RELATIVE_PATH: u32 = 0x08;
const HAS_WORKING_DIR: u32 = 0x10;
const IS_UNICODE: u32 = 0x80;

fn read_u16(data: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(data.get(at..at + 2)?.try_into().ok()?))
}

fn read_u32(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(data.get(at..at + 4)?.try_into().ok()?))
}

/// 将小端字节切片解码为 UTF-16 码元序列（忽略不足两字节的尾部）。
fn decode_utf16le_units(bytes: &[u8]) -> impl Iterator<Item = u16> + '_ {
    bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| u16::from_le_bytes(*c))
}

/// 自 `at` 起读取以 NUL 结尾的 UTF-16LE 字符串（越界时截至缓冲区末尾）。
fn read_utf16z(data: &[u8], at: usize) -> Option<String> {
    let units: Vec<u16> = decode_utf16le_units(data.get(at..)?)
        .take_while(|&u| u != 0)
        .collect();
    Some(String::from_utf16_lossy(&units))
}

/// 自 `at` 起读取以 NUL 结尾的 ANSI 字节串。
fn read_ansiz(data: &[u8], at: usize) -> Option<&[u8]> {
    let rest = data.get(at..)?;
    let end = rest.iter().position(|&b| b == 0).unwrap_or(rest.len());
    Some(&rest[..end])
}

/// ANSI 路径解码：先按 UTF-8；失败时 Windows 下按系统 ANSI 代码页（GBK、Shift-JIS 等）解码。
fn decode_ansi(bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() {
        return None;
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return Some(s.to_string());
    }
    decode_system_codepage(bytes)
}

#[cfg(target_os = "windows")]
fn decode_system_codepage(bytes: &[u8]) -> Option<String> {
    use windows_sys::Win32::Globalization::{MultiByteToWideChar, CP_ACP};
    let len = i32::try_from(bytes.len()).ok()?;
    // SAFETY: 输入切片与输出缓冲区在调用期间有效；第二次调用的缓冲区按第一次返回的长度分配。
    unsafe {
        let needed = MultiByteToWideChar(CP_ACP, 0, bytes.as_ptr(), len, std::ptr::null_mut(), 0);
        if needed <= 0 {
            return None;
        }
        let mut wide = vec![0u16; needed as usize];
        let written =
            MultiByteToWideChar(CP_ACP, 0, bytes.as_ptr(), len, wide.as_mut_ptr(), needed);
        if written <= 0 {
            return None;
        }
        wide.truncate(written as usize);
        Some(String::from_utf16_lossy(&wide))
    }
}

#[cfg(not(target_os = "windows"))]
fn decode_system_codepage(_bytes: &[u8]) -> Option<String> {
    None
}

/// 拼接 LocalBasePath 与 CommonPathSuffix。
fn join_base_suffix(base: &str, suffix: &str) -> String {
    if suffix.is_empty() {
        base.to_string()
    } else if base.ends_with(['\\', '/']) {
        format!("{base}{suffix}")
    } else {
        format!("{base}\\{suffix}")
    }
}

/// 从 LinkInfo 结构（`info` 以 LinkInfoSize 字段开头）取出磁盘上存在的目标路径。
fn link_info_target(info: &[u8]) -> Option<PathBuf> {
    let header_size = read_u32(info, 4)? as usize;
    if header_size >= 0x24 {
        let base_off = read_u32(info, 28)? as usize;
        let suffix_off = read_u32(info, 32)? as usize;
        if base_off > 0 {
            let base = read_utf16z(info, base_off).unwrap_or_default();
            let suffix = if suffix_off > 0 {
                read_utf16z(info, suffix_off).unwrap_or_default()
            } else {
                String::new()
            };
            if !base.is_empty() {
                let pb = PathBuf::from(join_base_suffix(&base, &suffix));
                if pb.is_file() {
                    return Some(pb);
                }
            }
        }
    }
    let base_off = read_u32(info, 16)? as usize;
    if base_off == 0 {
        return None;
    }
    let base = decode_ansi(read_ansiz(info, base_off)?)?;
    let suffix_off = read_u32(info, 24).unwrap_or(0) as usize;
    let suffix = if suffix_off > 0 {
        read_ansiz(info, suffix_off)
            .and_then(decode_ansi)
            .unwrap_or_default()
    } else {
        String::new()
    };
    let pb = PathBuf::from(join_base_suffix(&base, &suffix));
    pb.is_file().then_some(pb)
}

/// 读取一个 StringData 计数字符串，返回 (内容, 下一字段偏移)。
fn read_counted_string(data: &[u8], at: usize, unicode: bool) -> Option<(String, usize)> {
    let count = read_u16(data, at)? as usize;
    let start = at + 2;
    if unicode {
        let bytes = data.get(start..start + count * 2)?;
        let units: Vec<u16> = decode_utf16le_units(bytes).collect();
        Some((String::from_utf16_lossy(&units), start + count * 2))
    } else {
        let bytes = data.get(start..start + count)?;
        Some((decode_ansi(bytes).unwrap_or_default(), start + count))
    }
}

/// UTF-16LE 路径字符是否可出现在盘符之后的路径中。
fn is_path_unit(u: u16) -> bool {
    u >= 32
        && !matches!(u, 0x22 | 0x3C | 0x3E | 0x7C | 0x3F | 0x2A | 0x3A)
        && !(0x7F..0xA0).contains(&u)
        && u != 0xFFFF
}

/// 启发式：在 UTF-16LE 字节流中扫描 `X:\...\*.exe`。
fn scan_utf16_exe(data: &[u8]) -> Option<PathBuf> {
    let mut i = 0;
    while i + 6 <= data.len() {
        let is_drive = data[i].is_ascii_alphabetic()
            && data[i + 1] == 0
            && data[i + 2] == b':'
            && data[i + 3] == 0
            && data[i + 4] == b'\\'
            && data[i + 5] == 0;
        if !is_drive {
            i += 1;
            continue;
        }
        let mut units: Vec<u16> = vec![data[i] as u16, b':' as u16, b'\\' as u16];
        let mut j = i + 6;
        while j + 2 <= data.len() {
            let u = u16::from_le_bytes([data[j], data[j + 1]]);
            if !is_path_unit(u) {
                break;
            }
            units.push(u);
            j += 2;
        }
        let candidate = String::from_utf16_lossy(&units);
        if candidate.to_lowercase().ends_with(".exe") {
            let p = PathBuf::from(&candidate);
            if p.is_file() {
                return Some(p);
            }
        }
        i = j.max(i + 1);
    }
    None
}

/// 启发式：在字节流中扫描 ASCII `X:\...\*.exe`。
fn scan_ascii_exe(data: &[u8]) -> Option<PathBuf> {
    let mut i = 0;
    while i + 3 < data.len() {
        if data[i].is_ascii_alphabetic() && data[i + 1] == b':' && data[i + 2] == b'\\' {
            let start = i;
            let mut end = start + 3;
            while end < data.len()
                && data[end] >= 32
                && data[end] < 127
                && !matches!(data[end], b'"' | b'<' | b'>' | b'|' | b'?' | b'*')
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

/// 解析 `.lnk` 字节内容；`lnk_dir` 为快捷方式所在目录，用于解析相对路径。
fn resolve_lnk_bytes(data: &[u8], lnk_dir: Option<&Path>) -> Option<PathBuf> {
    if data.len() < HEADER_SIZE {
        return None;
    }
    let flags = read_u32(data, 0x14)?;

    // LinkTargetIDList：u16 IDListSize + 变长 IDList
    let mut cursor = Some(HEADER_SIZE);
    if flags & HAS_LINK_TARGET_ID_LIST != 0 {
        cursor = read_u16(data, HEADER_SIZE).map(|n| HEADER_SIZE + 2 + n as usize);
    }

    if let Some(mut at) = cursor {
        if flags & HAS_LINK_INFO != 0 {
            let info_size = read_u32(data, at).unwrap_or(0) as usize;
            let info_end = at.saturating_add(info_size).min(data.len());
            if info_size >= 28 {
                if let Some(found) = data.get(at..info_end).and_then(link_info_target) {
                    return Some(found);
                }
            }
            at = at.saturating_add(info_size);
        }

        // StringData：NameString、RelativePath、WorkingDir 依序出现（按标志位）
        let unicode = flags & IS_UNICODE != 0;
        let mut relative: Option<String> = None;
        let mut working_dir: Option<String> = None;
        let mut pos = Some(at);
        for bit in [HAS_NAME, HAS_RELATIVE_PATH, HAS_WORKING_DIR] {
            if flags & bit == 0 {
                continue;
            }
            let Some((value, next)) = pos.and_then(|p| read_counted_string(data, p, unicode))
            else {
                break;
            };
            match bit {
                HAS_RELATIVE_PATH => relative = Some(value),
                HAS_WORKING_DIR => working_dir = Some(value),
                _ => {}
            }
            pos = Some(next);
        }
        if let Some(rel) = relative.filter(|r| !r.trim().is_empty()) {
            let rel_path = PathBuf::from(rel.replace('\\', std::path::MAIN_SEPARATOR_STR));
            let bases = working_dir
                .filter(|w| !w.trim().is_empty())
                .map(PathBuf::from)
                .into_iter()
                .chain(lnk_dir.map(Path::to_path_buf));
            for base in bases {
                let joined = base.join(&rel_path);
                if joined.is_file() {
                    return Some(std::fs::canonicalize(&joined).map_or(joined, strip_verbatim));
                }
            }
        }
    }

    scan_utf16_exe(data).or_else(|| scan_ascii_exe(data))
}

/// 去掉 Windows `canonicalize` 产生的 `\\?\` 前缀。
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => p,
    }
}

impl AppScanner {
    /// 解析 Windows 快捷方式 (.lnk) 的真实目标程序物理路径（仅返回磁盘上存在的文件）。
    pub fn resolve_lnk_target(lnk_path: &Path) -> Option<PathBuf> {
        let data = std::fs::read(lnk_path).ok()?;
        resolve_lnk_bytes(&data, lnk_path.parent())
    }
}

#[cfg(test)]
mod resolver_lnk_tests {
    use super::*;

    fn header(flags: u32) -> Vec<u8> {
        let mut data = vec![0u8; HEADER_SIZE];
        data[0x00..0x04].copy_from_slice(&76u32.to_le_bytes());
        let clsid: [u8; 16] = [
            0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x46,
        ];
        data[0x04..0x14].copy_from_slice(&clsid);
        data[0x14..0x18].copy_from_slice(&flags.to_le_bytes());
        data
    }

    fn utf16z(s: &str) -> Vec<u8> {
        s.encode_utf16()
            .chain(Some(0))
            .flat_map(|u| u.to_le_bytes())
            .collect()
    }

    fn counted_utf16(s: &str) -> Vec<u8> {
        let units: Vec<u16> = s.encode_utf16().collect();
        let mut out = (units.len() as u16).to_le_bytes().to_vec();
        out.extend(units.iter().flat_map(|u| u.to_le_bytes()));
        out
    }

    /// 构造 MS-SHLLINK 合成夹具：flags = 0x01|0x02（IDList + LinkInfo 共存），
    /// LinkInfo 起始于 76 + 2 + id_list_size。IDList 填充 0xFF，使固定偏移 76 处读出的
    /// 字段非法；目标路径使用正斜杠，启发式分支（仅匹配 `X:\`）必然扫不到，
    /// 从而把"结构化路径"与"启发式兜底"区分开。
    fn build_lnk_with_idlist_and_linkinfo(target: &str, id_list_size: usize) -> Vec<u8> {
        let mut data = header(0x03);
        data.extend_from_slice(&(id_list_size as u16).to_le_bytes());
        data.extend(std::iter::repeat_n(0xFFu8, id_list_size));

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

    /// LinkInfoHeaderSize = 0x24 的 Unicode LinkInfo：ANSI 基路径故意写成无效值，
    /// 只有读 LocalBasePathUnicode + CommonPathSuffixUnicode 才能解出目标。
    fn build_lnk_with_unicode_linkinfo(base: &str, suffix: &str) -> Vec<u8> {
        let mut data = header(HAS_LINK_INFO | IS_UNICODE);
        let ansi_base = b"Z:\\nope\0";
        let ansi_suffix = b"\0";
        let base_w = utf16z(base);
        let suffix_w = utf16z(suffix);
        let ansi_base_off = 0x24usize;
        let ansi_suffix_off = ansi_base_off + ansi_base.len();
        let base_w_off = ansi_suffix_off + ansi_suffix.len();
        let suffix_w_off = base_w_off + base_w.len();
        let size = suffix_w_off + suffix_w.len();
        let mut info = Vec::new();
        info.extend_from_slice(&(size as u32).to_le_bytes());
        info.extend_from_slice(&0x24u32.to_le_bytes());
        info.extend_from_slice(&0x01u32.to_le_bytes());
        info.extend_from_slice(&0u32.to_le_bytes());
        info.extend_from_slice(&(ansi_base_off as u32).to_le_bytes());
        info.extend_from_slice(&0u32.to_le_bytes());
        info.extend_from_slice(&(ansi_suffix_off as u32).to_le_bytes());
        info.extend_from_slice(&(base_w_off as u32).to_le_bytes());
        info.extend_from_slice(&(suffix_w_off as u32).to_le_bytes());
        assert_eq!(info.len(), 0x24);
        info.extend_from_slice(ansi_base);
        info.extend_from_slice(ansi_suffix);
        info.extend_from_slice(&base_w);
        info.extend_from_slice(&suffix_w);
        assert_eq!(info.len(), size);
        data.extend_from_slice(&info);
        data
    }

    #[test]
    fn lnk_with_idlist_resolves_through_structured_path() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("fixture-target.exe");
        std::fs::write(&target, b"fake exe").unwrap();
        let target_str = target.to_string_lossy().replace('\\', "/");

        let lnk_bytes = build_lnk_with_idlist_and_linkinfo(&target_str, 16);
        let lnk_path = dir.path().join("fixture-both-flags.lnk");
        std::fs::write(&lnk_path, &lnk_bytes).unwrap();

        let resolved = AppScanner::resolve_lnk_target(&lnk_path);
        assert_eq!(resolved, Some(PathBuf::from(&target_str)));
    }

    #[test]
    fn unicode_link_info_resolves_chinese_path() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("目录_测试");
        std::fs::create_dir_all(&sub).unwrap();
        let target = sub.join("目标程序.exe");
        std::fs::write(&target, b"fake exe").unwrap();
        let base = format!("{}/", sub.to_string_lossy().replace('\\', "/"));

        let bytes = build_lnk_with_unicode_linkinfo(&base, "目标程序.exe");
        let resolved = resolve_lnk_bytes(&bytes, None).expect("unicode path resolves");
        assert!(resolved.is_file());
        assert!(resolved.to_string_lossy().ends_with("目标程序.exe"));
    }

    #[test]
    fn string_data_relative_path_resolves_against_working_dir_and_lnk_dir() {
        let dir = tempfile::tempdir().unwrap();
        let app_dir = dir.path().join("便携应用");
        std::fs::create_dir_all(&app_dir).unwrap();
        std::fs::write(app_dir.join("tool.exe"), b"fake exe").unwrap();

        let flags = HAS_NAME | HAS_RELATIVE_PATH | HAS_WORKING_DIR | IS_UNICODE;
        let mut with_wd = header(flags);
        with_wd.extend(counted_utf16("便携工具"));
        with_wd.extend(counted_utf16("tool.exe"));
        with_wd.extend(counted_utf16(&app_dir.to_string_lossy()));
        let resolved = resolve_lnk_bytes(&with_wd, None).expect("working dir + relative");
        assert!(resolved.ends_with("tool.exe"));

        // 无 WorkingDir 时按 `.lnk` 所在目录解析相对路径
        let mut no_wd = header(HAS_RELATIVE_PATH | IS_UNICODE);
        no_wd.extend(counted_utf16("便携应用\\tool.exe"));
        let resolved = resolve_lnk_bytes(&no_wd, Some(dir.path())).expect("lnk dir + relative");
        assert!(resolved.ends_with("tool.exe"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn utf16_heuristic_finds_unicode_drive_path() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("中文目录");
        std::fs::create_dir_all(&sub).unwrap();
        let target = sub.join("程序.exe");
        std::fs::write(&target, b"fake exe").unwrap();

        let mut data = header(0);
        data.extend_from_slice(&[0xAB; 10]);
        data.extend(utf16z(&target.to_string_lossy()));
        assert_eq!(resolve_lnk_bytes(&data, None), Some(target));
    }

    #[test]
    fn truncated_buffers_never_panic() {
        let full = build_lnk_with_unicode_linkinfo("/nonexistent/目录/", "a.exe");
        for len in 0..full.len() {
            let _ = resolve_lnk_bytes(&full[..len], None);
        }
        let mut strings = header(HAS_NAME | HAS_RELATIVE_PATH | HAS_WORKING_DIR | IS_UNICODE);
        strings.extend_from_slice(&[0xFF, 0x7F, 0x41]);
        assert_eq!(resolve_lnk_bytes(&strings, None), None);
        let mut idlist = header(HAS_LINK_TARGET_ID_LIST | HAS_LINK_INFO);
        idlist.extend_from_slice(&[0xFF, 0xFF]);
        assert_eq!(resolve_lnk_bytes(&idlist, None), None);
    }
}
