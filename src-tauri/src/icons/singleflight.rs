//! 按键单飞（图标与图片磁盘缓存共用）：同键并发调用共享同一个 `OnceCell`，
//! 只有首个调用执行初始化，其余等待同一结果。
//!
//! 每个调用持有 [`FlightGuard`]；守卫析构（正常返回、Future 被取消或 panic 展开）时，
//! 若表中仍是同一单元（`Arc::ptr_eq`）即摘除该键，表不随取消累积残留条目。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::OnceCell;

type FlightMap<T> = Mutex<HashMap<String, Arc<OnceCell<T>>>>;

/// 单飞表：键 → 正在进行的共享单元。
pub(crate) struct Flights<T> {
    map: FlightMap<T>,
}

impl<T> Flights<T> {
    pub(crate) fn new() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<OnceCell<T>>>> {
        match self.map.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// 加入（或发起）`key` 的单飞：返回持有共享单元的守卫。
    pub(crate) fn join(&self, key: String) -> FlightGuard<'_, T> {
        let cell = {
            let mut guard = self.lock();
            Arc::clone(
                guard
                    .entry(key.clone())
                    .or_insert_with(|| Arc::new(OnceCell::new())),
            )
        };
        FlightGuard {
            flights: self,
            key,
            cell,
        }
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.lock().len()
    }
}

/// 单飞参与凭据：经 [`FlightGuard::cell`] 取共享单元，析构时摘除仍属于自己的键。
pub(crate) struct FlightGuard<'a, T> {
    flights: &'a Flights<T>,
    key: String,
    cell: Arc<OnceCell<T>>,
}

impl<T> FlightGuard<'_, T> {
    pub(crate) fn cell(&self) -> &OnceCell<T> {
        &self.cell
    }
}

impl<T> Drop for FlightGuard<'_, T> {
    fn drop(&mut self) {
        let mut guard = self.flights.lock();
        if guard
            .get(&self.key)
            .is_some_and(|existing| Arc::ptr_eq(existing, &self.cell))
        {
            guard.remove(&self.key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn concurrent_joins_share_one_init_and_clean_up() {
        let flights: Flights<u32> = Flights::new();
        let runs = AtomicUsize::new(0);
        let run = || async {
            let flight = flights.join("k".to_string());
            *flight
                .cell()
                .get_or_init(|| async {
                    runs.fetch_add(1, Ordering::SeqCst);
                    tokio::task::yield_now().await;
                    7
                })
                .await
        };
        let (a, b) = tokio::join!(run(), run());
        assert_eq!((a, b), (7, 7));
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        assert_eq!(flights.len(), 0);
    }

    #[tokio::test]
    async fn cancelled_flight_removes_its_key() {
        let flights: Flights<u32> = Flights::new();
        let pending = async {
            let flight = flights.join("k".to_string());
            flight.cell().get_or_init(std::future::pending::<u32>).await;
        };
        let timed_out = tokio::time::timeout(std::time::Duration::from_millis(10), pending).await;
        assert!(timed_out.is_err());
        assert_eq!(flights.len(), 0, "cancelled future must not leak its entry");
    }
}
