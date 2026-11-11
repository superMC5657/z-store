//! 日期与时间戳通用辅助工具（零外部依赖，纯算术算法）。

/// 给定 Unix 时间戳秒数，返回其 UTC 对应的 (year, month, day)。
pub fn epoch_secs_to_ymd(secs: i64) -> (i32, u32, u32) {
    let days = secs.div_euclid(86400);
    days_to_ymd(days)
}

/// 将自 1970-01-01 以来的公历天数转换为 (year, month, day)。
pub fn days_to_ymd(days: i64) -> (i32, u32, u32) {
    let z = days + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i32) + (era as i32) * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y_final = if m <= 2 { y + 1 } else { y };
    (y_final, m, d)
}

/// 将 (year, month, day) 转换为自 1970-01-01 以来的公历天数。
pub fn ymd_to_days(mut year: i32, month: u32, day: u32) -> i64 {
    if month <= 2 {
        year -= 1;
    }
    let era = (if year >= 0 { year } else { year - 399 }) / 400;
    let yoe = (year - era * 400) as u32;
    let m_prime = if month <= 2 { month + 9 } else { month - 3 };
    let doy = (153 * m_prime + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    (era as i64) * 146097 + (doe as i64) - 719468
}

/// 将 Unix 秒数格式化为 YYYY-MM-DD 字符串。
pub fn format_epoch_secs_ymd(secs: i64) -> String {
    let (y, m, d) = epoch_secs_to_ymd(secs);
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// 解析形如 "YYYY-MM-DD" 的日期字符串为 epoch 天数。
pub fn parse_ymd_to_days(s: &str) -> Option<i64> {
    let parts: Vec<&str> = s.trim().split('-').collect();
    if parts.len() != 3 {
        return None;
    }
    let y: i32 = parts[0].parse().ok()?;
    let m: u32 = parts[1].parse().ok()?;
    let d: u32 = parts[2].parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(ymd_to_days(y, m, d))
}

/// 当前 UTC 对应的天数（基于 `crate::now_secs()`）。
pub fn today_days() -> i64 {
    crate::now_secs().div_euclid(86400)
}

/// 判定指定 "YYYY-MM-DD" 日期是否在天数区间之内：
/// - 当 `min_days == 0` 时为 `[-1, max_days]`（允许未来极小抖动，如时区微差 <= 1 天）；
/// - 当 `min_days > 0` 时为 `(min_days, max_days]`（左开右闭，与更小分段严格互斥去重，避免临界应用在多个分段重复霸榜）。
pub fn is_within_day_range(date_str: &str, min_days: u32, max_days: u32) -> bool {
    let Some(target_days) = parse_ymd_to_days(date_str) else {
        return false;
    };
    let now = today_days();
    let diff = now - target_days;
    if min_days == 0 {
        diff >= -1 && diff <= (max_days as i64)
    } else {
        diff > (min_days as i64) && diff <= (max_days as i64)
    }
}

/// 判定指定 "YYYY-MM-DD" 日期是否在最近 `since_days` 天之内（等价于 `is_within_day_range(date_str, 0, since_days)`）。
pub fn is_within_days(date_str: &str, since_days: u32) -> bool {
    is_within_day_range(date_str, 0, since_days)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_date_roundtrip() {
        let cases = [
            (1970, 1, 1, 0),
            (2026, 9, 10, ymd_to_days(2026, 9, 10)),
            (2026, 10, 22, ymd_to_days(2026, 10, 22)),
            (2000, 2, 29, ymd_to_days(2000, 2, 29)),
        ];
        for (y, m, d, expected_days) in cases {
            let days = ymd_to_days(y, m, d);
            assert_eq!(days, expected_days);
            assert_eq!(days_to_ymd(days), (y, m, d));
        }
    }

    #[test]
    fn test_parse_ymd() {
        assert_eq!(parse_ymd_to_days("1970-01-01"), Some(0));
        assert!(parse_ymd_to_days("invalid").is_none());
        assert!(parse_ymd_to_days("2026-13-01").is_none());
    }

    #[test]
    fn test_format_epoch_secs_ymd() {
        assert_eq!(format_epoch_secs_ymd(0), "1970-01-01");
        // 86400 * 20748 => 2026-10-22
        assert_eq!(format_epoch_secs_ymd(20748 * 86400), "2026-10-22");
    }

    #[test]
    fn test_is_within_day_range() {
        let today = today_days();
        let make_date = |offset_days: i64| format_epoch_secs_ymd((today - offset_days) * 86400);

        let d_future = make_date(-1);
        let d_today = make_date(0);
        let d_5 = make_date(5);
        let d_7 = make_date(7);
        let d_8 = make_date(8);
        let d_20 = make_date(20);
        let d_30 = make_date(30);
        let d_31 = make_date(31);
        let d_90 = make_date(90);
        let d_91 = make_date(91);

        // 0~7 范围：包含 -1(抖动), 0, 5, 7；排除 8
        assert!(is_within_day_range(&d_future, 0, 7));
        assert!(is_within_day_range(&d_today, 0, 7));
        assert!(is_within_day_range(&d_5, 0, 7));
        assert!(is_within_day_range(&d_7, 0, 7));
        assert!(!is_within_day_range(&d_8, 0, 7));

        // 7~30 范围 (7, 30]：排除 0, 5 以及第 7 天（已归属 0~7）；包含 8, 20, 30；排除 31
        assert!(!is_within_day_range(&d_today, 7, 30));
        assert!(!is_within_day_range(&d_5, 7, 30));
        assert!(!is_within_day_range(&d_7, 7, 30));
        assert!(is_within_day_range(&d_8, 7, 30));
        assert!(is_within_day_range(&d_20, 7, 30));
        assert!(is_within_day_range(&d_30, 7, 30));
        assert!(!is_within_day_range(&d_31, 7, 30));

        // 30~90 范围 (30, 90]：排除 20 以及第 30 天（已归属 7~30）；包含 31, 90；排除 91
        assert!(!is_within_day_range(&d_20, 30, 90));
        assert!(!is_within_day_range(&d_30, 30, 90));
        assert!(is_within_day_range(&d_31, 30, 90));
        assert!(is_within_day_range(&d_90, 30, 90));
        assert!(!is_within_day_range(&d_91, 30, 90));

        // 无效日期
        assert!(!is_within_day_range("invalid", 0, 7));
    }
}
