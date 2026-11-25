//! 按键单飞：同键并发调用共享同一个 `OnceCell`，仅首个调用执行初始化；
//! 守卫析构时按指针相等摘除对应键，取消或 panic 不残留条目。

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
        if guard.get(&self.key).is_some_and(|existing| {
            Arc::ptr_eq(existing, &self.cell) && Arc::strong_count(existing) == 2
        }) {
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

    #[tokio::test]
    async fn waiter_cancellation_keeps_in_flight_key_for_subsequent_callers() {
        let flights = Arc::new(Flights::<u32>::new());
        let runs = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());

        let f_a = Arc::clone(&flights);
        let runs_a = Arc::clone(&runs);
        let started_a = Arc::clone(&started);
        let release_a = Arc::clone(&release);
        let handle_a = tokio::spawn(async move {
            let guard = f_a.join("k".to_string());
            *guard
                .cell()
                .get_or_init(|| async {
                    runs_a.fetch_add(1, Ordering::SeqCst);
                    started_a.notify_one();
                    release_a.notified().await;
                    42
                })
                .await
        });

        started.notified().await;

        // Waiter B joins and cancels while A is still in flight.
        {
            let guard_b = flights.join("k".to_string());
            let timed_out = tokio::time::timeout(
                std::time::Duration::from_millis(10),
                guard_b.cell().get_or_init(|| async {
                    runs.fetch_add(1, Ordering::SeqCst);
                    99
                }),
            )
            .await;
            assert!(timed_out.is_err());
        }
        assert_eq!(
            flights.len(),
            1,
            "dropping a cancelled waiter must NOT remove the key while owner A is still in-flight"
        );

        // Caller C joins while A is still in flight and must share A's OnceCell.
        let f_c = Arc::clone(&flights);
        let runs_c = Arc::clone(&runs);
        let handle_c = tokio::spawn(async move {
            let guard = f_c.join("k".to_string());
            *guard
                .cell()
                .get_or_init(|| async {
                    runs_c.fetch_add(1, Ordering::SeqCst);
                    100
                })
                .await
        });

        tokio::task::yield_now().await;
        release.notify_one();

        assert_eq!(handle_a.await.unwrap(), 42);
        assert_eq!(handle_c.await.unwrap(), 42);
        assert_eq!(runs.load(Ordering::SeqCst), 1, "only one init must execute");
        assert_eq!(
            flights.len(),
            0,
            "key must be removed once the last holder drops"
        );
    }
}
