mod report;

fn main() {
    let o = shop_core::Order::new(3);
    report::print(&o);
}
