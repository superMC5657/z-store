//! 磁盘配额淘汰节流（图标 `icons/` 与图片 `cache/assets/` 共用）：
//! 按写入次数、新增字节与距上次淘汰的时长节流触发全目录配额扫描，
//! 将高频写入的目录遍历开销摊平到固定阈值窗口。

use std::sync::Mutex;
use std::time::{Duration, Instant};

struct ThrottleState {
    writes: u32,
    bytes: u64,
    /// 上次触发（或节流器首次记账）的时刻。
    since: Option<Instant>,
}

/// 写入计数节流器：任一阈值到达即放行一次淘汰并清零计数。
pub(crate) struct QuotaThrottle {
    every_writes: u32,
    every_bytes: u64,
    every: Option<Duration>,
    state: Mutex<ThrottleState>,
}

impl QuotaThrottle {
    /// `every_writes` 次写入、累计 `every_bytes` 新增字节，或距上次淘汰超过 `every`
    /// （`None` 不按时间触发）时放行。
    pub(crate) const fn new(every_writes: u32, every_bytes: u64, every: Option<Duration>) -> Self {
        Self {
            every_writes,
            every_bytes,
            every,
            state: Mutex::new(ThrottleState {
                writes: 0,
                bytes: 0,
                since: None,
            }),
        }
    }

    /// 记一次 `bytes` 字节的写入；返回 `true` 表示调用方应执行一次配额淘汰。
    pub(crate) fn record(&self, bytes: u64) -> bool {
        self.record_at(bytes, Instant::now())
    }

    fn record_at(&self, bytes: u64, now: Instant) -> bool {
        let mut st = match self.state.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        st.writes = st.writes.saturating_add(1);
        st.bytes = st.bytes.saturating_add(bytes);
        let since = *st.since.get_or_insert(now);
        let due = st.writes >= self.every_writes
            || st.bytes >= self.every_bytes
            || self
                .every
                .is_some_and(|window| now.saturating_duration_since(since) >= window);
        if due {
            st.writes = 0;
            st.bytes = 0;
            st.since = Some(now);
        }
        due
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fires_on_write_count_and_resets() {
        let t = QuotaThrottle::new(3, u64::MAX, None);
        let now = Instant::now();
        assert!(!t.record_at(1, now));
        assert!(!t.record_at(1, now));
        assert!(t.record_at(1, now));
        assert!(!t.record_at(1, now), "counters reset after firing");
    }

    #[test]
    fn fires_on_accumulated_bytes() {
        let t = QuotaThrottle::new(u32::MAX, 100, None);
        let now = Instant::now();
        assert!(!t.record_at(60, now));
        assert!(t.record_at(40, now));
        assert!(!t.record_at(99, now));
    }

    #[test]
    fn fires_after_time_window_since_last_prune() {
        let t = QuotaThrottle::new(u32::MAX, u64::MAX, Some(Duration::from_secs(300)));
        let start = Instant::now();
        assert!(!t.record_at(1, start));
        assert!(!t.record_at(1, start + Duration::from_secs(299)));
        assert!(t.record_at(1, start + Duration::from_secs(300)));
        assert!(!t.record_at(1, start + Duration::from_secs(301)));
    }
}
