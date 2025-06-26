use chrono::{DateTime, Utc};

pub trait TimeProvider {
    fn now(&self) -> DateTime<Utc>;
}

pub struct SystemTimeProvider;

impl TimeProvider for SystemTimeProvider {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}

#[cfg(test)]
pub struct MockTimeProvider {
    fixed_time: DateTime<Utc>,
}

#[cfg(test)]
impl MockTimeProvider {
    pub fn new(fixed_time: DateTime<Utc>) -> Self {
        Self { fixed_time }
    }
}

#[cfg(test)]
impl TimeProvider for MockTimeProvider {
    fn now(&self) -> DateTime<Utc> {
        self.fixed_time
    }
}