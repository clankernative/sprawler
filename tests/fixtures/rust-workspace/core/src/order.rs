pub struct Order {
    pub total: u64,
}

impl Order {
    pub fn new(total: u64) -> Self {
        Order { total }
    }
}
